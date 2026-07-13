from __future__ import annotations

from typing import Any, Literal
from urllib.parse import quote

from bot.config import ThreadsSettings
from bot.http import JsonHttpClient

SearchType = Literal["TOP", "RECENT"]
SearchMode = Literal["KEYWORD", "TAG"]


class ThreadsClient:
    def __init__(self, settings: ThreadsSettings, http: JsonHttpClient | None = None) -> None:
        self.base_url = settings.api_base_url.rstrip("/")
        self.user_id = quote(settings.user_id, safe="")
        self.http = http or JsonHttpClient()
        self.headers = {"Authorization": f"Bearer {settings.access_token}"}

    def create_container(
        self,
        text: str,
        *,
        media_url: str | None = None,
        reply_to_id: str | None = None,
    ) -> str:
        query: dict[str, str] = {"text": text}
        if media_url:
            lowercase_url = media_url.lower().split("?", 1)[0]
            if lowercase_url.endswith((".mp4", ".mov", ".webm")):
                query.update({"media_type": "VIDEO", "video_url": media_url})
            else:
                query.update({"media_type": "IMAGE", "image_url": media_url})
        else:
            query["media_type"] = "TEXT"
        if reply_to_id:
            query["reply_to_id"] = reply_to_id

        data = self.http.request(
            "POST",
            f"{self.base_url}/{self.user_id}/threads",
            headers=self.headers,
            query=query,
        )
        if not isinstance(data, dict) or not data.get("id"):
            raise RuntimeError("Threads create container response has no id")
        return str(data["id"])

    def publish_container(self, container_id: str) -> str:
        data = self.http.request(
            "POST",
            f"{self.base_url}/{self.user_id}/threads_publish",
            headers=self.headers,
            query={"creation_id": container_id},
        )
        if not isinstance(data, dict) or not data.get("id"):
            raise RuntimeError("Threads publish response has no id")
        return str(data["id"])

    def reply_to(self, reply_id: str, text: str) -> str:
        container_id = self.create_container(text, reply_to_id=reply_id)
        return self.publish_container(container_id)

    def keyword_search(
        self,
        query_text: str,
        *,
        search_type: SearchType,
        search_mode: SearchMode,
        limit: int = 25,
    ) -> list[dict[str, Any]]:
        data = self.http.request(
            "GET",
            f"{self.base_url}/keyword_search",
            headers=self.headers,
            query={
                "q": query_text,
                "search_type": search_type,
                "search_mode": search_mode,
                "fields": "id,text,username,permalink,timestamp",
                "limit": max(1, min(limit, 50)),
            },
        )
        if not isinstance(data, dict) or not isinstance(data.get("data"), list):
            raise RuntimeError("Threads keyword search returned an unexpected response")
        return [item for item in data["data"] if isinstance(item, dict)]
