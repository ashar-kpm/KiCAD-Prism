import asyncio
import os
import subprocess
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api._helpers import get_project_for_role_or_404, _row_to_project, require_output_type, resolve_path_within_root
from app.core.security import AuthenticatedUser, require_designer, require_viewer
from app.services import (
    file_service,
    path_config_service,
    project_import_service,
    project_properties_service,
    project_service,
)
from app.services.workspace_service import workspace
from app.services.comments_url_service import build_comments_source_urls, resolve_comments_base_url
from app.services.git_service import (
    get_commit_distance,
    get_commits_list,
    get_commits_list_filtered,
    get_file_from_commit,
    get_file_from_commit_with_prefix,
    get_releases,
    get_releases_filtered,
)
from app.services.path_config_service import PathConfig

router = APIRouter(dependencies=[Depends(require_viewer)])

ARCHIVE_DIR_NAMES = {"archive", "archived", "old", "backup", "backups", "obsolete"}

class Monorepo(BaseModel):
    name: str
    path: str
    project_count: int
    last_synced: Optional[str] = None
    repo_url: Optional[str] = None


class ProjectPropertiesTitleBlock(BaseModel):
    title: str = ""
    date: str = ""
    rev: str = ""
    company: str = ""
    comments: Dict[str, str] = Field(default_factory=dict)


class ProjectPropertiesSchematicFile(BaseModel):
    path: str
    filename: str
    version: Optional[int] = None
    generator: Optional[str] = None
    generator_version: Optional[str] = None
    paper: Optional[str] = None
    uuid: Optional[str] = None
    title_block: Optional[ProjectPropertiesTitleBlock] = None


class ProjectPropertiesPcbFile(BaseModel):
    path: str
    filename: str
    version: Optional[int] = None
    generator: Optional[str] = None
    generator_version: Optional[str] = None
    paper: Optional[str] = None
    dimensions_mm: Optional[Dict[str, float]] = None
    thickness_mm: Optional[float] = None
    title_block: Optional[ProjectPropertiesTitleBlock] = None


class ProjectPropertiesLatestCommit(BaseModel):
    hash: str
    full_hash: str
    author: str
    email: str
    date: str
    message: str


class ProjectPropertiesTag(BaseModel):
    tag: str
    commit_hash: str
    date: str
    message: str


class ProjectPropertiesRepository(BaseModel):
    latest_commit: Optional[ProjectPropertiesLatestCommit] = None
    latest_tag: Optional[ProjectPropertiesTag] = None


class ProjectPropertiesFiles(BaseModel):
    schematic: Optional[ProjectPropertiesSchematicFile] = None
    pcb: Optional[ProjectPropertiesPcbFile] = None


class ProjectPropertiesResponse(BaseModel):
    project: project_service.Project
    repository: ProjectPropertiesRepository
    files: ProjectPropertiesFiles


def _repo_context(project: project_service.Project) -> tuple[str, Optional[str]]:
    """Return repository path and optional subproject relative path for project-scoped git operations."""
    if project.parent_repo_path and project.sub_path:
        return project.parent_repo_path, project.sub_path
    if project.import_type == "type2_subproject":
        return project.parent_repo_path or os.path.dirname(project.path), project.sub_path
    return project.path, None


def _resolve_output_dir(project_path: str, output_type: str) -> str:
    resolved = path_config_service.resolve_paths(project_path)
    output_dir = (
        resolved.design_outputs_dir
        if output_type == "design"
        else resolved.manufacturing_outputs_dir
    )
    if not output_dir:
        raise HTTPException(status_code=404, detail=f"{output_type} outputs folder not configured")
    return output_dir


def _read_utf8_file(file_path: str | Path, *, not_found_detail: str, read_error_prefix: str) -> str:
    path = Path(file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail=not_found_detail)
    if path.is_dir():
        raise HTTPException(status_code=400, detail="Cannot read directory")

    try:
        return path.read_text(encoding="utf-8")
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"{read_error_prefix}: {error}") from error


def _read_file_from_commit(
    project: project_service.Project,
    commit: str,
    file_path: str,
    *,
    relative_prefix: Optional[str] = None,
) -> str:
    """
    Read a file from commit for both standalone and Type-2 subproject contexts.

    - Standalone: uses project path directly.
    - Type-2: reads from parent repo and applies project sub-path prefix.
    """
    repo_path, sub_path = _repo_context(project)
    if sub_path is None:
        return get_file_from_commit(repo_path, commit, file_path)

    prefix = sub_path
    if relative_prefix:
        prefix = f"{sub_path}/{relative_prefix}" if sub_path else relative_prefix

    return get_file_from_commit_with_prefix(repo_path, commit, file_path, prefix)


def _filter_projects_for_user(
    projects: List[project_service.Project],
    user: AuthenticatedUser,
) -> List[project_service.Project]:
    return [p for p in projects if workspace.is_folder_visible_to_role(p.folder_id, user.role)]


def _load_project_readme_content(
    project: project_service.Project,
    commit: Optional[str] = None,
) -> Optional[str]:
    config = path_config_service.get_path_config(project.path)
    readme_filename = config.readme or "README.md"

    if commit:
        try:
            return _read_file_from_commit(project, commit, readme_filename)
        except HTTPException as error:
            if error.status_code == 404:
                return None
            raise

    resolved = path_config_service.resolve_paths(project.path, config)
    readme_path = resolved.readme_path
    if not readme_path:
        return None

    try:
        return _read_utf8_file(
            readme_path,
            not_found_detail="README not found",
            read_error_prefix="Error reading README",
        )
    except HTTPException as error:
        if error.status_code == 404:
            return None
        raise

@router.get("/", response_model=List[project_service.Project])
async def list_projects(user: AuthenticatedUser = Depends(require_viewer)):
    """Return all registered projects (both Type-1 and Type-2)."""
    rows = await asyncio.to_thread(workspace.get_all_projects, user.role)
    return [_row_to_project(r) for r in rows]

@router.get("/monorepos", response_model=List[Monorepo])
async def list_monorepos(user: AuthenticatedUser = Depends(require_viewer)):
    """
    List all monorepos with their metadata.
    Uses workspace DB — no subprocess calls.
    """
    repos = await asyncio.to_thread(workspace.get_repositories, "multi")
    result = []
    for repo in repos:
        projects = await asyncio.to_thread(workspace.get_projects_by_repo, repo["id"])
        abs_path = workspace._abs_clone_path(repo["clone_path"])
        result.append(Monorepo(
            name=repo["name"],
            path=abs_path,
            project_count=len(projects),
            last_synced=repo.get("last_synced_at"),
            repo_url=repo.get("url"),
        ))
    return result

@router.get("/monorepos/{repo_name}/structure")
async def get_monorepo_structure(
    repo_name: str,
    subpath: str = "",
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Get folder structure for a monorepo at a given subpath.
    Returns folders and projects at that level.
    """
    repo_path = os.path.join(project_service.MONOREPOS_ROOT, repo_name)
    if not os.path.exists(repo_path) or not os.path.isdir(repo_path):
        raise HTTPException(status_code=404, detail="Monorepo not found")
    
    current_path = resolve_path_within_root(repo_path, subpath, invalid_detail="Invalid path")
    if not current_path.exists() or not current_path.is_dir():
        raise HTTPException(status_code=404, detail="Path not found")
    
    folders = []
    projects = []
    
    all_rows = workspace.get_all_projects(user.role)
    all_registered = [_row_to_project(r) for r in all_rows]
    repo_projects = {p.sub_path: p for p in all_registered if p.parent_repo == repo_name}
    
    for item_path in current_path.iterdir():
        if not item_path.is_dir():
            continue

        item_name = item_path.name
        if item_name.startswith(".") or item_name.lower() in ARCHIVE_DIR_NAMES:
            continue

        relative_path = os.path.relpath(item_path, repo_path)

        # Count items in folder (for display)
        try:
            child_names = os.listdir(item_path)
            item_count = len(child_names)
        except OSError:
            child_names = []
            item_count = 0

        folders.append({
            "name": item_name,
            "path": relative_path,
            "item_count": item_count
        })

        if any(name.endswith(".kicad_pro") for name in child_names):
            project = repo_projects.get(relative_path)
            if project:
                custom_display_name = path_config_service.get_project_display_name(str(item_path))
                projects.append({
                    "id": project.id,
                    "name": project.name,
                    "display_name": custom_display_name,
                    "relative_path": relative_path,
                    "has_thumbnail": project_service.get_project_thumbnail_path(project.id) is not None,
                    "last_modified": project.last_modified
                })
    
    return {
        "repo_name": repo_name,
        "current_path": subpath,
        "folders": folders,
        "projects": projects
    }

@router.get("/search")
async def search_projects(
    q: str = "",
    limit: int = Query(default=100, ge=1, le=500),
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Search across all projects (standalone and monorepo sub-projects).
    Uses SQL LIKE — no full hydration needed.
    """
    query = q.strip()
    if not query:
        return {"results": []}

    rows = await asyncio.to_thread(workspace.search_projects, query, limit, user.role)
    results = []
    for r in rows:
        results.append({
            "id": r["id"],
            "name": r["name"],
            "description": r.get("description", ""),
            "parent_repo": r.get("parent_repo"),
            "sub_path": r.get("relative_path") if r.get("relative_path") != "." else None,
            "last_modified": r.get("last_modified", ""),
            "thumbnail_url": f"/api/projects/{r['id']}/thumbnail" if r.get("thumbnail_rel") else None,
        })
    return {"results": results}

class AnalyzeRequest(BaseModel):
    url: str

class ImportRequest(BaseModel):
    url: str
    import_type: str  # "type1" or "type2"
    selected_paths: Optional[List[str]] = None

@router.post("/analyze", dependencies=[Depends(require_designer)])
async def analyze_repository(request: AnalyzeRequest):
    """
    Analyze a repository to determine import type and discover KiCAD projects.
    Returns Type-1 or Type-2 classification and project list.
    """
    try:
        job_id = project_import_service.start_analyze_job(request.url)
        return {"job_id": job_id, "status": "started"}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")

@router.post("/import", dependencies=[Depends(require_designer)])
async def import_project(request: ImportRequest):
    """
    Start an async project import job.
    For Type-1: imports single project at root.
    For Type-2: imports selected subprojects.
    """
    try:
        job_id = project_import_service.start_import_job(
            repo_url=request.url,
            import_type=request.import_type,
            selected_paths=request.selected_paths
        )
        return {"job_id": job_id, "status": "started"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    """
    Get the status of an import job.
    """
    status = project_import_service.get_job_status(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="Job not found")
    return status

@router.post("/{project_id}/sync", dependencies=[Depends(require_designer)])
async def sync_project_endpoint(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Sync project repository with remote.
    Type-1: pulls the project repo.
    Type-2: pulls the parent repo.
    """
    _ = get_project_for_role_or_404(project_id, user.role)
    result = project_import_service.sync_project(project_id)
    
    if result["status"] == "error":
        raise HTTPException(status_code=400, detail=result["message"])

    file_service.invalidate_file_listing_cache()
    
    return result

class WorkflowRequest(BaseModel):
    type: str # design, manufacturing, render
    author: Optional[str] = "anonymous"

@router.post("/{project_id}/workflows", dependencies=[Depends(require_designer)])
async def trigger_workflow(
    project_id: str,
    request: WorkflowRequest,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Trigger a KiCAD workflow (jobset output).
    """
    valid_types = ["design", "manufacturing", "render"]
    if request.type not in valid_types:
        raise HTTPException(status_code=400, detail="Invalid workflow type")
        
    try:
        _ = get_project_for_role_or_404(project_id, user.role)
        job_id = project_service.start_workflow_job(project_id, request.type, request.author)
        return {"job_id": job_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/{project_id}/thumbnail")
async def get_project_thumbnail(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    # Use cached thumbnail path from DB, fallback to filesystem detection
    row = workspace.get_project_by_id(project_id)
    thumbnail_rel = row.get("thumbnail_rel") if row else None
    if thumbnail_rel:
        abs_path = os.path.join(project.path, thumbnail_rel)
        if os.path.isfile(abs_path):
            return FileResponse(abs_path, headers={"Cache-Control": "public, max-age=300"})
    # Fallback: live filesystem detection
    path = project_service.get_project_thumbnail_path(project_id)
    if not path:
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=300"})

@router.get("/{project_id}", response_model=project_service.Project)
async def get_project_detail(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """Get detailed project information."""
    return get_project_for_role_or_404(project_id, user.role)


@router.get("/{project_id}/properties", response_model=ProjectPropertiesResponse)
async def get_project_properties(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    return await asyncio.to_thread(_build_project_properties, project)


def _build_project_properties(project: project_service.Project) -> ProjectPropertiesResponse:
    repo_path, relative_path = _repo_context(project)
    if relative_path:
        releases = get_releases_filtered(repo_path, relative_path)
        latest_commits = get_commits_list_filtered(repo_path, relative_path, 1)
    else:
        releases = get_releases(repo_path)
        latest_commits = get_commits_list(repo_path, 1)

    latest_commit = latest_commits[0] if latest_commits else None
    latest_tag = releases[0] if releases else None

    schematic_path = project_service.find_schematic_file(project.path)
    pcb_path = project_service.find_pcb_file(project.path)
    schematic_metadata = project_properties_service.extract_schematic_metadata(project.path, schematic_path)
    pcb_metadata = project_properties_service.extract_pcb_metadata(project.path, pcb_path)

    return ProjectPropertiesResponse(
        project=project,
        repository=ProjectPropertiesRepository(
            latest_commit=(
                ProjectPropertiesLatestCommit(**latest_commit)
                if latest_commit
                else None
            ),
            latest_tag=(
                ProjectPropertiesTag(**latest_tag)
                if latest_tag
                else None
            ),
        ),
        files=ProjectPropertiesFiles(
            schematic=(
                ProjectPropertiesSchematicFile(**schematic_metadata)
                if schematic_metadata
                else None
            ),
            pcb=(
                ProjectPropertiesPcbFile(**pcb_metadata)
                if pcb_metadata
                else None
            ),
        ),
    )


@router.get("/{project_id}/overview")
async def get_project_overview(
    project_id: str,
    commit: str = None,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Return project detail and README content in one payload for the overview page.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    return {
        "project": project.model_dump(),
        "readme": _load_project_readme_content(project, commit),
    }


@router.get("/{project_id}/comments/source-urls")
async def get_project_comments_source_urls(
    request: Request,
    project_id: str,
    base_url: Optional[str] = Query(
        default=None,
        description="Optional override base URL (e.g. http://localhost:8000).",
    ),
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Get helper URLs to configure KiCad comments REST source for this project.
    """
    project = get_project_for_role_or_404(project_id, user.role)

    resolved_base_url = resolve_comments_base_url(request, explicit_base_url=base_url)
    urls = build_comments_source_urls(project.id, resolved_base_url)

    return {
        "project_id": project.id,
        "project_name": project.display_name or project.name,
        "base_url": urls["base_url"],
        "list_url": urls["absolute"]["list_url"],
        "patch_url_template": urls["absolute"]["patch_url_template"],
        "reply_url_template": urls["absolute"]["reply_url_template"],
        "delete_url_template": urls["absolute"]["delete_url_template"],
        "relative": urls["relative"],
    }

@router.delete("/{project_id}", dependencies=[Depends(require_designer)])
async def delete_project_endpoint(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Delete a project from the registry.
    For standalone projects, this also deletes the project files.
    For monorepo sub-projects, only removes the registry entry.
    """
    _ = get_project_for_role_or_404(project_id, user.role)
    success = await asyncio.to_thread(workspace.delete_project, project_id)
    if not success:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"message": "Project deleted successfully"}

@router.get("/{project_id}/files", response_model=List[file_service.FileItem])
async def get_project_files(
    project_id: str,
    type: str = "design",
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    List files in Design-Outputs or Manufacturing-Outputs.
    
    Args:
        project_id: Project identifier
        type: 'design' or 'manufacturing'
    """
    output_type = require_output_type(type)
    project = get_project_for_role_or_404(project_id, user.role)
    return file_service.get_project_files(project.path, output_type)

@router.get("/{project_id}/download")
async def download_file(
    project_id: str,
    path: str,
    type: str = "design",
    inline: bool = False,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Download a specific file from Design-Outputs or Manufacturing-Outputs.
    
    Args:
        project_id: Project identifier
        path: Relative path to file within output folder
        type: 'design' or 'manufacturing'
        inline: If True, serve as inline content (view in browser)
    """
    output_type = require_output_type(type)
    project = get_project_for_role_or_404(project_id, user.role)
    output_dir = _resolve_output_dir(project.path, output_type)

    file_path = resolve_path_within_root(output_dir, path, invalid_detail="Invalid file path")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    if file_path.is_dir():
        raise HTTPException(status_code=400, detail="Cannot download directory")

    disposition = "inline" if inline else "attachment"
    return FileResponse(file_path, filename=file_path.name, content_disposition_type=disposition)

@router.get("/{project_id}/readme")
async def get_project_readme(
    project_id: str,
    commit: str = None,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Get README content from project root.
    If commit is provided, fetch from that commit; otherwise use working directory.
    For Type-2 projects, uses parent repo with relative path prefix.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    content = _load_project_readme_content(project, commit)
    if content is None:
        raise HTTPException(status_code=404, detail="README not found")
    return {"content": content}

@router.get("/{project_id}/asset/{asset_path:path}")
async def get_project_asset(
    project_id: str,
    asset_path: str,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Serve assets (images, etc.) from project directory.
    Typically used for README image references.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    file_path = resolve_path_within_root(project.path, asset_path, invalid_detail="Invalid asset path")

    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Asset not found")

    if file_path.is_dir():
        raise HTTPException(status_code=400, detail="Cannot serve directory")

    return FileResponse(file_path)

@router.get("/{project_id}/docs")
async def get_docs_files(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    List all files in the documentation folder.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    resolved = path_config_service.resolve_paths(project.path)
    docs_dir = resolved.documentation_dir
    
    if not docs_dir or not os.path.exists(docs_dir):
        return []  # Return empty list if docs not configured/found
    
    return file_service.get_files_recursive(docs_dir)

@router.get("/{project_id}/docs/content")
async def get_doc_file_content(
    project_id: str,
    path: str,
    commit: str = None,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Get markdown file content from documentation folder.
    If commit is provided, fetch from that commit; otherwise use working directory.
    For Type-2 projects, uses parent repo with relative path prefix.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    # Get documentation path from config
    config = path_config_service.get_path_config(project.path)
    docs_path = config.documentation or "docs"
    
    # If viewing a specific commit, use Git
    if commit:
        try:
            file_path = path if project.import_type == "type2_subproject" else f"{docs_path}/{path}"
            content = _read_file_from_commit(project, commit, file_path, relative_prefix=docs_path)
            return {"content": content, "path": path}
        except HTTPException:
            raise
    
    # Otherwise read from filesystem
    resolved = path_config_service.resolve_paths(project.path)
    docs_dir = resolved.documentation_dir
    
    if not docs_dir or not os.path.exists(docs_dir):
        raise HTTPException(status_code=404, detail="Documentation folder not found")
    
    file_path = resolve_path_within_root(docs_dir, path, invalid_detail="Invalid file path")
    return {
        "content": _read_utf8_file(
            file_path,
            not_found_detail="File not found",
            read_error_prefix="Error reading file",
        ),
        "path": path,
    }

@router.get("/{project_id}/releases")
async def get_project_releases(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Get list of Git releases/tags for a project.
    For Type-2 projects, uses parent repo with subproject file tracking.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    repo_path, relative_path = _repo_context(project)
    if relative_path:
        releases = get_releases_filtered(repo_path, relative_path)
    else:
        releases = get_releases(project.path)
    
    return {"releases": releases}

@router.get("/{project_id}/commits/distance")
async def get_project_commit_distance(
    project_id: str,
    commit: str,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Count how many commits behind HEAD the requested commit is.
    For Type-2 projects, only commits affecting the subproject path are counted.
    """
    project = get_project_for_role_or_404(project_id, user.role)

    repo_path, relative_path = _repo_context(project)
    commits_behind = get_commit_distance(repo_path, commit, relative_path)
    return {"commits_behind": commits_behind}

@router.get("/{project_id}/commits")
async def get_project_commits(
    project_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Get list of commits for a project.
    For Type-2 projects, shows only commits affecting the subproject.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    repo_path, relative_path = _repo_context(project)
    if relative_path:
        commits = get_commits_list_filtered(repo_path, relative_path, limit)
    else:
        commits = get_commits_list(project.path, limit)
    
    return {"commits": commits}


@router.get("/{project_id}/schematic")
async def get_project_schematic(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    
    path = project_service.find_schematic_file(project.path)
    if not path:
        raise HTTPException(status_code=404, detail="Schematic not found")
    return FileResponse(path)

@router.get("/{project_id}/schematic/subsheets")
async def get_project_subsheets(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    
    main_path = project_service.find_schematic_file(project.path)
    if not main_path:
        raise HTTPException(status_code=404, detail="Schematic not found")
        
    subsheets = sorted(project_service.get_subsheets(project.path, main_path))
    # Convert filenames to URLs
    subsheet_urls = [{"name": s, "url": f"/api/projects/{project_id}/asset/{s}"} for s in subsheets]
    return {"files": subsheet_urls}

@router.get("/{project_id}/pcb")
async def get_project_pcb(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    
    path = project_service.find_pcb_file(project.path)
    if not path:
        raise HTTPException(status_code=404, detail="PCB not found")
    return FileResponse(path)

@router.get("/{project_id}/3d-model")
async def get_project_3d_model(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    
    path = project_service.find_3d_model(project.path)
    if not path:
        raise HTTPException(status_code=404, detail="3D model not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=300"})

@router.get("/{project_id}/ibom")
async def get_project_ibom(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    project = get_project_for_role_or_404(project_id, user.role)
    
    path = project_service.find_ibom_file(project.path)
    if not path:
        raise HTTPException(status_code=404, detail="iBoM not found")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=60"})


# Path Configuration Endpoints

@router.get("/{project_id}/config")
async def get_project_config(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Get path configuration for a project.
    Returns the current path configuration (from .prism.json or auto-detected).
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    config = path_config_service.get_path_config(project.path)
    resolved = path_config_service.resolve_paths(project.path, config)
    explicit_config = path_config_service._load_prism_config(project.path)
    effective_config = config.model_copy(deep=True)
    if not effective_config.project_name:
        effective_config.project_name = project.display_name
    if not effective_config.description:
        effective_config.description = project.description
    
    return {
        "config": effective_config.model_dump(),
        "resolved": resolved.model_dump(),
        "source": "explicit" if explicit_config else "auto-detected"
    }


@router.post("/{project_id}/detect-paths", dependencies=[Depends(require_designer)])
async def detect_project_paths(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Run auto-detection on project paths.
    Returns detected paths without saving them.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    detected = path_config_service.detect_paths(project.path)
    
    return {
        "detected": detected.model_dump(),
        "validation": path_config_service.validate_config(project.path, detected)
    }


@router.put("/{project_id}/config", dependencies=[Depends(require_designer)])
async def update_project_config(
    project_id: str,
    config: PathConfig,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Update path configuration for a project.
    Saves configuration to .prism.json file.
    """
    project = get_project_for_role_or_404(project_id, user.role)

    if config.project_name is not None:
        normalized_name = config.project_name.strip()
        config.project_name = normalized_name or None

    if config.description is not None:
        normalized_description = config.description.strip()
        config.description = normalized_description or f"Project {project.name}"
    
    # Validate the config before saving
    validation = path_config_service.validate_config(project.path, config)
    
    # Save the configuration
    path_config_service.save_path_config(project.path, config)
    
    # Clear cache to ensure fresh resolution
    path_config_service.clear_config_cache(project.path)
    file_service.invalidate_file_listing_cache()
    
    # Get resolved paths
    resolved = path_config_service.resolve_paths(project.path, config)
    
    return {
        "config": config.model_dump(),
        "resolved": resolved.model_dump(),
        "validation": validation
    }


class ProjectNameRequest(BaseModel):
    display_name: str


class ProjectDescriptionRequest(BaseModel):
    description: str


@router.get("/{project_id}/name")
async def get_project_name(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Get the display name for a project.
    Returns custom name from .prism.json or fallback name.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    return {
        "display_name": project.display_name,
        "fallback_name": project.name
    }


@router.put("/{project_id}/name", dependencies=[Depends(require_designer)])
async def update_project_name(
    project_id: str,
    request: ProjectNameRequest,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Update the display name for a project in .prism.json.
    """
    project = get_project_for_role_or_404(project_id, user.role)
    
    display_name = request.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name cannot be empty")

    # Get current config
    config = path_config_service.get_path_config(project.path)
    
    # Update project name
    config.project_name = display_name
    
    # Save to .prism.json
    path_config_service.save_path_config(project.path, config)
    await asyncio.to_thread(workspace.update_project, project_id, display_name=display_name)
    
    return {
        "display_name": display_name,
        "message": "Project name updated successfully"
    }


@router.get("/{project_id}/description")
async def get_project_description(project_id: str, user: AuthenticatedUser = Depends(require_viewer)):
    """
    Get project description from project registry.
    """
    project = get_project_for_role_or_404(project_id, user.role)

    return {
        "description": project.description
    }


@router.put("/{project_id}/description", dependencies=[Depends(require_designer)])
async def update_project_description(
    project_id: str,
    request: ProjectDescriptionRequest,
    user: AuthenticatedUser = Depends(require_viewer),
):
    """
    Update project description in project registry.
    """
    project = get_project_for_role_or_404(project_id, user.role)

    next_description = request.description.strip()
    if not next_description:
        next_description = f"Project {project.name}"

    updated = await asyncio.to_thread(workspace.update_project, project_id, description=next_description)
    if not updated:
        raise HTTPException(status_code=404, detail="Project not found")

    # Also persist to .prism.json for compatibility
    config = path_config_service.get_path_config(project.path)
    config.description = next_description
    path_config_service.save_path_config(project.path, config)

    return {
        "description": next_description,
        "message": "Project description updated successfully"
    }
