from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from bot.config import SupabaseSettings
from bot.http import JsonHttpClient
from bot.models import ContentItem, Interaction


class SupabaseClient:
    def __init__(self, settings: SupabaseSettings, http: JsonHttpClient | None = None) -> None:
        self.base_url = settings.url.rstrip("/")
        self.http = http or JsonHttpClient()
        self.headers = {
            "apikey": settings.service_role_key,
            "Content-Profile": "public",
            "Accept-Profile": "public",
        }
        if not settings.service_role_key.startswith("sb_secret_"):
            self.headers["Authorization"] = f"Bearer {settings.service_role_key}"

    def _rpc(self, function_name: str, payload: Mapping[str, Any]) -> Any:
        return self.http.request(
            "POST",
            f"{self.base_url}/rest/v1/rpc/{function_name}",
            headers=self.headers,
            json_body=dict(payload),
        )

    def claim_interactions(
        self,
        *,
        batch_size: int = 10,
        max_attempts: int = 5,
        stale_lock_minutes: int = 10,
    ) -> list[Interaction]:
        data = self._rpc(
            "claim_interactions",
            {
                "batch_size": batch_size,
                "max_attempts": max_attempts,
                "stale_lock_minutes": stale_lock_minutes,
            },
        )
        if not isinstance(data, list):
            raise RuntimeError("claim_interactions returned an unexpected response")
        return [Interaction.from_record(item) for item in data if isinstance(item, dict)]

    def claim_due_content(
        self,
        *,
        batch_size: int = 5,
        max_attempts: int = 5,
        stale_lock_minutes: int = 15,
    ) -> list[ContentItem]:
        data = self._rpc(
            "claim_due_content",
            {
                "batch_size": batch_size,
                "max_attempts": max_attempts,
                "stale_lock_minutes": stale_lock_minutes,
            },
        )
        if not isinstance(data, list):
            raise RuntimeError("claim_due_content returned an unexpected response")
        return [ContentItem.from_record(item) for item in data if isinstance(item, dict)]

    def _update(self, table: str, row_id: str, values: Mapping[str, Any]) -> None:
        self.http.request(
            "PATCH",
            f"{self.base_url}/rest/v1/{table}",
            headers={**self.headers, "Prefer": "return=minimal"},
            query={"id": f"eq.{row_id}"},
            json_body=dict(values),
        )

    def update_interaction(self, interaction_id: str, values: Mapping[str, Any]) -> None:
        self._update("interactions", interaction_id, values)

    def update_content(self, content_id: str, values: Mapping[str, Any]) -> None:
        self._update("content_queue", content_id, values)

    def mark_interaction_failed(self, interaction_id: str, error: str, max_attempts: int = 5) -> None:
        self._rpc(
            "mark_interaction_failed",
            {"p_id": interaction_id, "p_error": error[:4_000], "p_max_attempts": max_attempts},
        )

    def mark_content_failed(self, content_id: str, error: str, max_attempts: int = 5) -> None:
        self._rpc(
            "mark_content_failed",
            {"p_id": content_id, "p_error": error[:4_000], "p_max_attempts": max_attempts},
        )

    def insert_keyword_interaction(self, record: Mapping[str, Any]) -> None:
        self.http.request(
            "POST",
            f"{self.base_url}/rest/v1/interactions",
            headers={
                **self.headers,
                "Prefer": "resolution=ignore-duplicates,return=minimal",
            },
            query={"on_conflict": "source_item_id"},
            json_body=dict(record),
        )
