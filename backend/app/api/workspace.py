import asyncio
from typing import Any, Dict, List

from fastapi import APIRouter, Depends

from app.core.security import AuthenticatedUser, require_viewer
from app.services.workspace_service import workspace
from app.api._helpers import _row_to_project

router = APIRouter(dependencies=[Depends(require_viewer)])


@router.get("/bootstrap")
async def get_workspace_bootstrap(user: AuthenticatedUser = Depends(require_viewer)):
    data = await asyncio.to_thread(workspace.get_bootstrap_data, user.role)
    projects = [_row_to_project(r) for r in data["projects"]]
    return {"projects": projects, "folders": data["folders"]}
