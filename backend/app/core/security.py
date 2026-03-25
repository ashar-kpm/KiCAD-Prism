from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from app.core.config import settings
from app.core.roles import Role, normalize_role, role_meets_minimum
from app.core.session import SESSION_COOKIE_NAME, decode_session_token
from app.services import access_service


class AuthenticatedUser(BaseModel):
    email: str
    name: str
    picture: str = ""
    role: Role


def guest_user() -> AuthenticatedUser:
    return AuthenticatedUser(email="guest@local", name="Guest User", picture="", role="admin")


def _resolve_allowed_user_role(email: str) -> Role | None:
    role = access_service.resolve_user_role(email)
    if role is None:
        return None
    return normalize_role(role)


async def get_current_user(request: Request) -> AuthenticatedUser:
    if not settings.AUTH_ENABLED:
        return guest_user()

    token = request.cookies.get(SESSION_COOKIE_NAME)
    payload = decode_session_token(token or "")
    if not payload:
        raise HTTPException(status_code=401, detail="Authentication required")

    role = _resolve_allowed_user_role(payload["email"])
    if not role:
        raise HTTPException(status_code=403, detail="Access denied. No role assignment found for your account.")

    return AuthenticatedUser(
        email=payload["email"],
        name=payload["name"],
        picture=payload["picture"],
        role=role,
    )


async def require_viewer(user: AuthenticatedUser = Depends(get_current_user)) -> AuthenticatedUser:
    return user


async def require_designer(user: AuthenticatedUser = Depends(get_current_user)) -> AuthenticatedUser:
    if not role_meets_minimum(user.role, "designer"):
        raise HTTPException(status_code=403, detail="Designer role required")
    return user


async def require_admin(user: AuthenticatedUser = Depends(get_current_user)) -> AuthenticatedUser:
    if not role_meets_minimum(user.role, "admin"):
        raise HTTPException(status_code=403, detail="Admin role required")
    return user
