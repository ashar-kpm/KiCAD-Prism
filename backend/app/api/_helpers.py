from pathlib import Path

from fastapi import HTTPException

from app.core.roles import Role
from app.services.workspace_service import workspace
from app.services import project_service


VALID_OUTPUT_TYPES = {"design", "manufacturing"}


def get_project_or_404(project_id: str) -> project_service.Project:
    row = workspace.get_project_by_id(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    return _row_to_project(row)


def get_project_for_role_or_404(project_id: str, role: Role) -> project_service.Project:
    row = workspace.get_project_by_id(project_id)
    if not row:
        raise HTTPException(status_code=404, detail="Project not found")
    if not workspace.is_folder_visible_to_role(row.get("folder_id"), role):
        raise HTTPException(status_code=404, detail="Project not found")
    return _row_to_project(row)


def _row_to_project(row: dict) -> project_service.Project:
    """Convert a workspace DB row dict into the Project Pydantic model."""
    return project_service.Project(
        id=row["id"],
        name=row["name"],
        display_name=row.get("display_name"),
        description=row.get("description", ""),
        path=row.get("path", ""),
        last_modified=row.get("last_modified", ""),
        registered_at=row.get("registered_at"),
        thumbnail_url=f"/api/projects/{row['id']}/thumbnail" if row.get("thumbnail_rel") else None,
        sub_path=row.get("relative_path") if row.get("relative_path") != "." else None,
        parent_repo=row.get("parent_repo"),
        repo_url=row.get("repo_url"),
        import_type=row.get("import_type"),
        parent_repo_path=row.get("parent_repo_path"),
        folder_id=row.get("folder_id"),
    )


def require_output_type(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in VALID_OUTPUT_TYPES:
        raise HTTPException(status_code=400, detail="Type must be 'design' or 'manufacturing'")
    return normalized


def resolve_path_within_root(root: str, relative_path: str, *, invalid_detail: str) -> Path:
    root_path = Path(root).resolve()
    target_path = (root_path / relative_path).resolve()

    try:
        target_path.relative_to(root_path)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=invalid_detail) from error

    return target_path

