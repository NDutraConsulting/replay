from datetime import datetime

from pydantic import BaseModel, Field


class User(BaseModel):
    user_id: str
    username: str
    password_hash: str
    created_at: datetime


class SignupRequest(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=200)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class UserView(BaseModel):
    """What the browser may see about an account: never the password hash."""

    user_id: str
    username: str
