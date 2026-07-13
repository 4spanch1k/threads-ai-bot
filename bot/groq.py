from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from bot.config import GroqSettings
from bot.http import JsonHttpClient
from bot.models import Intent

ALLOWED_SIGNALS = {
    "explicit_need",
    "vendor_search",
    "pricing",
    "timeline",
    "contact_intent",
    "service_interest",
    "conversation",
    "praise",
    "promotion",
    "irrelevant",
}
ALLOWED_RISK_FLAGS = {"aggression", "complaint", "legal", "reputation", "personal_data"}


@dataclass(frozen=True, slots=True)
class GroqEvidence:
    intent: Intent
    signals: tuple[str, ...]
    risk_flags: tuple[str, ...]
    proposed_reply: str | None


class GroqClient:
    def __init__(self, settings: GroqSettings, http: JsonHttpClient | None = None) -> None:
        self.api_key = settings.api_key
        self.model = settings.model
        self.http = http or JsonHttpClient(timeout_seconds=30.0)

    def classify(self, text: str) -> GroqEvidence:
        payload = {
            "model": self.model,
            "temperature": 0,
            "max_completion_tokens": 350,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Ты классификатор входящих сообщений для digital-агентства в Казахстане. "
                        "Верни только JSON: intent (lead|engagement|spam), signals (массив только из: "
                        "explicit_need,vendor_search,pricing,timeline,contact_intent,service_interest,"
                        "conversation,praise,promotion,irrelevant), risk_flags (массив только из: "
                        "aggression,complaint,legal,reputation,personal_data), proposed_reply "
                        "(короткий вежливый ответ на языке сообщения или null). Не придумывай факты, "
                        "цены, сроки и гарантии. Lead — явная или вероятная потребность в сайте, "
                        "приложении, автоматизации или разработчике."
                    ),
                },
                {"role": "user", "content": text[:2_000]},
            ],
        }
        response = self.http.request(
            "POST",
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json_body=payload,
        )
        content = self._extract_content(response)
        try:
            result = json.loads(content)
        except json.JSONDecodeError as error:
            raise RuntimeError("Groq returned invalid classifier JSON") from error
        if not isinstance(result, dict):
            raise RuntimeError("Groq classifier result must be an object")

        raw_intent = result.get("intent")
        if raw_intent not in {"lead", "engagement", "spam"}:
            raise RuntimeError("Groq classifier returned an invalid intent")
        signals = self._filtered_strings(result.get("signals"), ALLOWED_SIGNALS)
        risk_flags = self._filtered_strings(result.get("risk_flags"), ALLOWED_RISK_FLAGS)
        proposed_reply = result.get("proposed_reply")
        if not isinstance(proposed_reply, str) or not proposed_reply.strip():
            proposed_reply = None
        elif len(proposed_reply) > 450:
            proposed_reply = proposed_reply[:447].rstrip() + "..."

        return GroqEvidence(
            intent=raw_intent,
            signals=signals,
            risk_flags=risk_flags,
            proposed_reply=proposed_reply,
        )

    @staticmethod
    def _extract_content(response: Any) -> str:
        if not isinstance(response, dict):
            raise RuntimeError("Groq returned an unexpected response")
        choices = response.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise RuntimeError("Groq response has no choices")
        message = choices[0].get("message")
        if not isinstance(message, dict) or not isinstance(message.get("content"), str):
            raise RuntimeError("Groq response has no message content")
        return message["content"]

    @staticmethod
    def _filtered_strings(value: Any, allowed: set[str]) -> tuple[str, ...]:
        if not isinstance(value, list):
            return ()
        return tuple(dict.fromkeys(item for item in value if isinstance(item, str) and item in allowed))
