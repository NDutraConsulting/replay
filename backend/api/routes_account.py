from fastapi import APIRouter, Cookie, Depends, Response

from api.deps import SESSION_COOKIE, get_current_user
from config import Settings, get_settings
from controllers import account_controller
from models.user import LoginRequest, SignupRequest, User, UserView

router = APIRouter()


def _set_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=settings.COOKIE_SECURE,
        max_age=settings.SESSION_MAX_AGE_DAYS * 86400,
    )


@router.post("/api/account/signup", response_model=UserView, status_code=201)
async def signup(request: SignupRequest, response: Response, settings: Settings = Depends(get_settings)):
    user, token = await account_controller.signup(settings, request.username, request.password)
    _set_cookie(response, settings, token)
    return UserView(user_id=user.user_id, username=user.username)


@router.post("/api/account/login", response_model=UserView)
async def login(request: LoginRequest, response: Response, settings: Settings = Depends(get_settings)):
    user, token = await account_controller.login(settings, request.username, request.password)
    _set_cookie(response, settings, token)
    return UserView(user_id=user.user_id, username=user.username)


@router.post("/api/account/logout")
async def logout(
    response: Response,
    settings: Settings = Depends(get_settings),
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
):
    if session_token:
        await account_controller.logout(settings, session_token)
    response.delete_cookie(SESSION_COOKIE)
    return {"status": "logged_out"}


@router.get("/api/me", response_model=UserView)
async def me(user: User = Depends(get_current_user)):
    return UserView(user_id=user.user_id, username=user.username)
