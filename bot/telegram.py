from __future__ import annotations

from urllib.parse import quote

from bot.config import TelegramSettings
from bot.http import JsonHttpClient


class TelegramClient:
    def __init__(self, settings: TelegramSettings, http: JsonHttpClient | None = None) -> None:
        self.chat_id = settings.chat_id
        self.endpoint = f"https://api.telegram.org/bot{quote(settings.bot_token, safe=':')}/sendMessage"
        self.http = http or JsonHttpClient()

    def send(self, text: str) -> None:
        self.http.request(
            "POST",
            self.endpoint,
            json_body={
                "chat_id": self.chat_id,
                "text": text[:4_000],
            },
        )
