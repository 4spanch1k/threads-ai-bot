from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Intent = Literal["lead", "engagement", "spam"]
Confidence = Literal["low", "medium", "high"]


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


@dataclass(frozen=True, slots=True)
class Interaction:
    id: str
    source_item_id: str
    source: str
    event_type: str
    comment_text: str
    post_id: str | None
    username: str | None
    intent: Intent | None
    signals: tuple[str, ...]
    risk_flags: tuple[str, ...]
    confidence_level: Confidence | None
    bot_reply_text: str | None
    reply_sent: bool
    notification_sent: bool

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "Interaction":
        raw_intent = record.get("intent")
        intent: Intent | None = raw_intent if raw_intent in {"lead", "engagement", "spam"} else None
        raw_confidence = record.get("confidence_level")
        confidence: Confidence | None = (
            raw_confidence if raw_confidence in {"low", "medium", "high"} else None
        )
        return cls(
            id=str(record["id"]),
            source_item_id=str(record["source_item_id"]),
            source=str(record["source"]),
            event_type=str(record["event_type"]),
            comment_text=str(record["comment_text"]),
            post_id=str(record["post_id"]) if record.get("post_id") else None,
            username=str(record["username"]) if record.get("username") else None,
            intent=intent,
            signals=_string_list(record.get("signals")),
            risk_flags=_string_list(record.get("risk_flags")),
            confidence_level=confidence,
            bot_reply_text=str(record["bot_reply_text"]) if record.get("bot_reply_text") else None,
            reply_sent=bool(record.get("reply_sent", False)),
            notification_sent=bool(record.get("notification_sent", False)),
        )


@dataclass(frozen=True, slots=True)
class ContentItem:
    id: str
    text: str
    media_url: str | None
    container_id: str | None

    @classmethod
    def from_record(cls, record: dict[str, Any]) -> "ContentItem":
        return cls(
            id=str(record["id"]),
            text=str(record["text"]),
            media_url=str(record["media_url"]) if record.get("media_url") else None,
            container_id=str(record["container_id"]) if record.get("container_id") else None,
        )


@dataclass(frozen=True, slots=True)
class Classification:
    intent: Intent
    signals: tuple[str, ...]
    risk_flags: tuple[str, ...]
    confidence_level: Confidence
    bot_reply_text: str | None
