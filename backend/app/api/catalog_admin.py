from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.security import AuthenticatedUser, require_admin
from app.services.component_catalog_service import catalog_service

router = APIRouter(prefix="/api/catalog", tags=["catalog"], dependencies=[Depends(require_admin)])


class CreateManualComponentRequest(BaseModel):
    value: str
    description: str
    datasheet: str
    manufacturer: str
    manufacturer_part_number: str
    category: str = ""
    package_name: str = ""
    vendor: str = ""
    vendor_part_number: str = ""
    mass_g: str = ""
    rqjc_c_w: str = ""
    rqjc_top_c_w: str = ""
    temp_max_c: str = ""
    temp_min_c: str = ""
    power_dissipation_w: str = ""
    rate: str = ""
    sap_code: str = ""


class UpdateComponentMetadataRequest(BaseModel):
    value: str | None = None
    description: str | None = None
    datasheet_url: str | None = None
    manufacturer: str | None = None
    mpn: str | None = None
    category: str | None = None
    package_name: str | None = None
    vendor: str | None = None
    vendor_part_number: str | None = None
    mass_g: str | None = None
    rqjc_c_w: str | None = None
    rqjc_top_c_w: str | None = None
    temp_max_c: str | None = None
    temp_min_c: str | None = None
    power_dissipation_w: str | None = None
    rate: str | None = None
    sap_code: str | None = None


class ReleaseStatusRequest(BaseModel):
    release_status: str = ""
    workflow_stage: str = ""


@router.get("/components")
async def list_catalog_components(
    q: str = Query(default=""),
    source: str | None = Query(default=None),
    availability_state: str | None = Query(default=None),
    workflow_stage: str | None = Query(default=None),
    category: str | None = Query(default=None),
    include_inactive: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
    sort_by: str = Query(default=""),
    sort_dir: str = Query(default="asc"),
    lightweight: bool = Query(default=False),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        return catalog_service.list_components(
            query=q,
            source=source,
            availability_state=availability_state,
            workflow_stage=workflow_stage,
            category=category,
            include_inactive=include_inactive,
            page=page,
            page_size=page_size,
            sort_by=sort_by,
            sort_dir=sort_dir,
            lightweight=lightweight,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/categories")
async def list_catalog_categories(user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    return {"categories": catalog_service.list_categories()}


@router.get("/workflow/summary")
async def workflow_summary(user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    return catalog_service.workflow_summary()


@router.post("/components")
async def create_catalog_component(
    payload: CreateManualComponentRequest,
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        return catalog_service.create_manual_component(**payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/components/{component_id}")
async def get_catalog_component(component_id: str, user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    component = catalog_service.get_component(component_id)
    if not component:
        raise HTTPException(status_code=404, detail="Component not found")
    return component


@router.patch("/components/{component_id}")
async def update_catalog_component(
    component_id: str,
    payload: UpdateComponentMetadataRequest,
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    updates: dict[str, Any] = {
        key: value
        for key, value in payload.model_dump().items()
        if value is not None
    }
    try:
        component = catalog_service.update_component_metadata(component_id, updates)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not component:
        raise HTTPException(status_code=404, detail="Component not found")
    return component


@router.post("/components/{component_id}/symbol-import")
async def import_symbol_library(
    component_id: str,
    file: UploadFile = File(...),
    target_library: str = Form(default=""),
    selected_symbol: str = Form(default=""),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded symbol library was empty")

    try:
        return catalog_service.import_symbol_library(
            component_id,
            upload_name=file.filename or "uploaded.kicad_sym",
            payload=payload,
            target_library=target_library or component_id,
            selected_symbol=selected_symbol,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/components/{component_id}/footprint-import")
async def import_footprint(
    component_id: str,
    file: UploadFile = File(...),
    target_library: str = Form(default=""),
    selected_footprint: str = Form(default=""),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded footprint payload was empty")

    try:
        return catalog_service.import_footprint(
            component_id,
            upload_name=file.filename or "uploaded.kicad_mod",
            payload=payload,
            target_library=target_library or "Prism_Footprints",
            selected_footprint=selected_footprint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/components/{component_id}/assets/{asset_type}")
async def import_auxiliary_asset(
    component_id: str,
    asset_type: str,
    file: UploadFile = File(...),
    target_library: str = Form(default=""),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Uploaded asset payload was empty")

    try:
        return catalog_service.attach_auxiliary_asset(
            component_id,
            asset_type=asset_type,
            upload_name=file.filename or f"{asset_type}.bin",
            payload=payload,
            target_library=target_library or "Prism_Assets",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/components/{component_id}/assets/{asset_type}")
async def detach_component_asset(
    component_id: str,
    asset_type: str,
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        return catalog_service.detach_asset(component_id, asset_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/components/{component_id}")
async def delete_catalog_component(component_id: str, user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    if not catalog_service.delete_component(component_id):
        raise HTTPException(status_code=404, detail="Component not found")
    return {"ok": True}


@router.post("/components/{component_id}/release")
async def transition_release_status(
    component_id: str,
    payload: ReleaseStatusRequest,
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        stage = payload.workflow_stage or payload.release_status
        component = catalog_service.set_release_status(component_id, stage)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not component:
        raise HTTPException(status_code=404, detail="Component not found")
    return component


@router.post("/components/{component_id}/previews/regenerate")
async def regenerate_component_previews(component_id: str, user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    try:
        component = catalog_service.regenerate_component_previews(component_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not component:
        raise HTTPException(status_code=404, detail="Component not found")
    return component


@router.post("/exports/kicad-dbl")
async def export_kicad_dbl_bundle(user: AuthenticatedUser = Depends(require_admin)):
    _ = user
    try:
        return catalog_service.export_kicad_dbl_bundle()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ─── Phase 2: CSV Import Routes ──────────────────────────────────────────────

@router.post("/components/import-csv")
async def import_metadata_csv(
    file: UploadFile = File(...),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    content = await file.read()
    try:
        csv_str = content.decode("utf-8")
        return catalog_service.import_metadata_csv(csv_str)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/stock/sync-csv")
async def import_stock_csv(
    file: UploadFile = File(...),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    content = await file.read()
    try:
        csv_str = content.decode("utf-8")
        return catalog_service.import_stock_csv(csv_str)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# ─── Phase 2: Asset Browsing/Linking Routes ──────────────────────────────────

@router.get("/assets/browse")
async def browse_library_assets(
    asset_type: str = Query(...),
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        files = catalog_service.browse_library_assets(asset_type)
        return {"files": files}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class LinkAssetRequest(BaseModel):
    file_path: str
    target_library: str = ""
    target_name: str = ""


@router.post("/components/{component_id}/assets/{asset_type}/link")
async def link_library_asset(
    component_id: str,
    asset_type: str,
    payload: LinkAssetRequest,
    user: AuthenticatedUser = Depends(require_admin),
):
    _ = user
    try:
        return catalog_service.link_library_asset(
            component_id,
            asset_type,
            file_path_rel=payload.file_path,
            target_library=payload.target_library,
            target_name=payload.target_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
