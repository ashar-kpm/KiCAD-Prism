import json
import os
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.core.roles import Role, normalize_role

ROLE_STORE_VERSION = "1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_email(email: str) -> str:
    normalized = (email or "").strip().lower()
    if not normalized or "@" not in normalized:
        raise ValueError("Invalid email")
    return normalized


def _bootstrap_admin_set() -> set[str]:
    return {email.strip().lower() for email in settings.BOOTSTRAP_ADMIN_USERS if email.strip()}


def _default_viewer_domain_set() -> set[str]:
    return {domain.strip().lower() for domain in settings.DEFAULT_VIEWER_DOMAINS if domain.strip()}


def _default_store() -> dict[str, Any]:
    return {
        "version": ROLE_STORE_VERSION,
        "updated_at": _now_iso(),
        "updated_by": "system",
        "users": {},
    }


def _role_store_path() -> str:
    return settings.RESOLVED_ROLE_STORE_PATH


def _ensure_role_store_directory() -> None:
    os.makedirs(os.path.dirname(_role_store_path()), exist_ok=True)


_role_cache: dict[str, Any] | None = None
_role_cache_mtime: float = 0.0


def _load_role_store() -> dict[str, Any]:
    global _role_cache, _role_cache_mtime
    path = _role_store_path()

    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return _default_store()

    if _role_cache is not None and _role_cache_mtime == mtime:
        return _role_cache

    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            payload = _default_store()
        users = payload.get("users")
        if not isinstance(users, dict):
            payload["users"] = {}
        _role_cache = payload
        _role_cache_mtime = mtime
        return payload
    except (OSError, json.JSONDecodeError):
        return _default_store()


def _save_role_store(payload: dict[str, Any]) -> None:
    _ensure_role_store_directory()
    path = _role_store_path()
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
    os.replace(tmp_path, path)


def _entry_to_role(entry: Any) -> Role | None:
    if isinstance(entry, str):
        return normalize_role(entry)
    if isinstance(entry, dict):
        return normalize_role(entry.get("role"))
    return None


def _load_explicit_user_role(normalized_email: str) -> Role | None:
    payload = _load_role_store()
    users = payload.get("users") or {}
    return _entry_to_role(users.get(normalized_email))


def resolve_user_role(email: str) -> Role | None:
    normalized_email = _normalize_email(email)
    if normalized_email in _bootstrap_admin_set():
        return "admin"

    explicit_role = _load_explicit_user_role(normalized_email)
    if explicit_role:
        return explicit_role

    domain = normalized_email.split("@", 1)[-1]
    if domain in _default_viewer_domain_set():
        return "viewer"

    return None


def ensure_default_viewer_assignment(email: str) -> dict[str, str] | None:
    normalized_email = _normalize_email(email)
    if normalized_email in _bootstrap_admin_set():
        return {"email": normalized_email, "role": "admin", "source": "bootstrap"}

    explicit_role = _load_explicit_user_role(normalized_email)
    if explicit_role:
        return {"email": normalized_email, "role": explicit_role, "source": "store"}

    domain = normalized_email.split("@", 1)[-1]
    if domain not in _default_viewer_domain_set():
        return None

    return upsert_user_role(email=normalized_email, role="viewer", updated_by="system@local")


def list_role_assignments() -> list[dict[str, str]]:
    payload = _load_role_store()
    users = payload.get("users") or {}
    bootstrap_admins = _bootstrap_admin_set()

    assignments: list[dict[str, str]] = []
    for email, value in users.items():
        if email in bootstrap_admins:
            assignments.append({"email": str(email), "role": "admin", "source": "bootstrap"})
            continue
        role = _entry_to_role(value)
        if not role:
            continue
        assignments.append({"email": str(email), "role": role, "source": "store"})

    bootstrap_only = bootstrap_admins - {entry["email"] for entry in assignments}
    for email in sorted(bootstrap_only):
        assignments.append({"email": email, "role": "admin", "source": "bootstrap"})

    assignments.sort(key=lambda item: item["email"])
    return assignments


def upsert_user_role(email: str, role: Role, updated_by: str) -> dict[str, str]:
    normalized_email = _normalize_email(email)
    if normalized_email in _bootstrap_admin_set():
        if role != "admin":
            raise ValueError("Cannot override bootstrap admin role assignment")
        return {"email": normalized_email, "role": "admin", "source": "bootstrap"}

    payload = _load_role_store()
    users = payload.setdefault("users", {})
    users[normalized_email] = {
        "role": role,
        "updated_at": _now_iso(),
        "updated_by": _normalize_email(updated_by),
    }
    payload["version"] = ROLE_STORE_VERSION
    payload["updated_at"] = _now_iso()
    payload["updated_by"] = _normalize_email(updated_by)
    _save_role_store(payload)

    return {"email": normalized_email, "role": role, "source": "store"}


def delete_user_role(email: str, updated_by: str) -> bool:
    normalized_email = _normalize_email(email)
    if normalized_email in _bootstrap_admin_set():
        raise ValueError("Cannot delete bootstrap admin role assignment")

    payload = _load_role_store()
    users = payload.setdefault("users", {})
    if normalized_email not in users:
        return False

    users.pop(normalized_email, None)
    payload["updated_at"] = _now_iso()
    payload["updated_by"] = _normalize_email(updated_by)
    _save_role_store(payload)
    return True
