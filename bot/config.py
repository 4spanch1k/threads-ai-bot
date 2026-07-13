from __future__ import annotations

import os
from dataclasses import dataclass


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Required environment variable {name} is missing")
    return value


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean value")


def env_int(name: str, default: int, *, minimum: int = 1, maximum: int = 100) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


@dataclass(frozen=True, slots=True)
class SupabaseSettings:
    url: str
    service_role_key: str

    @classmethod
    def from_env(cls) -> "SupabaseSettings":
        return cls(
            url=required_env("SUPABASE_URL"),
            service_role_key=required_env("SUPABASE_SERVICE_ROLE_KEY"),
        )


@dataclass(frozen=True, slots=True)
class ThreadsSettings:
    access_token: str
    user_id: str
    api_base_url: str

    @classmethod
    def from_env(cls) -> "ThreadsSettings":
        return cls(
            access_token=required_env("THREADS_ACCESS_TOKEN"),
            user_id=required_env("THREADS_USER_ID"),
            api_base_url=os.getenv("THREADS_API_BASE_URL", "https://graph.threads.net").rstrip("/"),
        )


@dataclass(frozen=True, slots=True)
class GroqSettings:
    api_key: str
    model: str

    @classmethod
    def from_env(cls) -> "GroqSettings":
        return cls(
            api_key=required_env("GROQ_API_KEY"),
            model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip(),
        )


@dataclass(frozen=True, slots=True)
class TelegramSettings:
    bot_token: str
    chat_id: str

    @classmethod
    def from_env(cls) -> "TelegramSettings":
        return cls(
            bot_token=required_env("TELEGRAM_BOT_TOKEN"),
            chat_id=required_env("TELEGRAM_CHAT_ID"),
        )
