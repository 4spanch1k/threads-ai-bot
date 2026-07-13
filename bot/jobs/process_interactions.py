from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Protocol

from bot.classifier import Classifier
from bot.config import (
    GroqSettings,
    SupabaseSettings,
    TelegramSettings,
    ThreadsSettings,
    env_bool,
    env_int,
    required_env,
)
from bot.groq import GroqClient
from bot.jobs.common import log, utc_now
from bot.models import Classification, Interaction
from bot.supabase import SupabaseClient
from bot.telegram import TelegramClient
from bot.threads import ThreadsClient


class ClassifierClient(Protocol):
    def classify(self, text: str) -> Classification: ...


class InteractionDatabase(Protocol):
    def update_interaction(self, interaction_id: str, values: Mapping[str, Any]) -> None: ...


class ReplyClient(Protocol):
    def reply_to(self, reply_id: str, text: str) -> str: ...


class NotificationClient(Protocol):
    def send(self, text: str) -> None: ...


def existing_classification(interaction: Interaction) -> Classification | None:
    if not interaction.intent or not interaction.confidence_level:
        return None
    return Classification(
        intent=interaction.intent,
        signals=interaction.signals,
        risk_flags=interaction.risk_flags,
        confidence_level=interaction.confidence_level,
        bot_reply_text=interaction.bot_reply_text,
    )


def should_reply(interaction: Interaction, classification: Classification) -> bool:
    if interaction.source != "own_reply" or classification.risk_flags or classification.intent == "spam":
        return False
    if classification.intent == "lead":
        return classification.confidence_level == "high"
    return classification.intent == "engagement" and classification.confidence_level == "high"


def should_notify(interaction: Interaction, classification: Classification) -> bool:
    if classification.risk_flags:
        return True
    if classification.intent != "lead":
        return False
    return classification.confidence_level in {"medium", "high"}


def alert_text(interaction: Interaction, classification: Classification) -> str:
    username = f"@{interaction.username}" if interaction.username else "неизвестный пользователь"
    risks = ", ".join(classification.risk_flags) if classification.risk_flags else "нет"
    return (
        "Threads Lead Bot\n"
        f"Источник: {interaction.source}\n"
        f"Пользователь: {username}\n"
        f"Класс: {classification.intent} / {classification.confidence_level}\n"
        f"Риски: {risks}\n"
        f"Текст: {interaction.comment_text}"
    )


def process_one(
    interaction: Interaction,
    *,
    classifier: ClassifierClient,
    database: InteractionDatabase,
    shadow_mode: bool,
    threads: ReplyClient | None,
    telegram: NotificationClient | None,
) -> None:
    classification = existing_classification(interaction) or classifier.classify(interaction.comment_text)
    classification_values = {
        "intent": classification.intent,
        "signals": list(classification.signals),
        "risk_flags": list(classification.risk_flags),
        "confidence_level": classification.confidence_level,
        "bot_reply_text": classification.bot_reply_text,
        "is_lead": classification.intent == "lead",
        "last_error": None,
    }

    if shadow_mode:
        database.update_interaction(
            interaction.id,
            {
                **classification_values,
                "status": "classified",
                "processing_started_at": None,
                "next_retry_at": None,
                "processed_at": utc_now(),
            },
        )
        log(
            "interaction classified in shadow mode",
            interaction_id=interaction.id,
            intent=classification.intent,
            confidence=classification.confidence_level,
        )
        return

    if threads is None or telegram is None:
        raise RuntimeError("Action clients are required outside shadow mode")

    # Keep the row leased as processing until every required side effect is persisted.
    database.update_interaction(interaction.id, classification_values)

    if should_reply(interaction, classification) and not interaction.reply_sent:
        if not classification.bot_reply_text:
            raise RuntimeError("A reply is required but bot_reply_text is empty")
        reply_id = interaction.source_item_id.split(":", 1)[-1]
        threads.reply_to(reply_id, classification.bot_reply_text)
        database.update_interaction(interaction.id, {"reply_sent": True})

    if should_notify(interaction, classification) and not interaction.notification_sent:
        telegram.send(alert_text(interaction, classification))
        database.update_interaction(interaction.id, {"notification_sent": True})

    database.update_interaction(
        interaction.id,
        {
            "status": "actioned",
            "processing_started_at": None,
            "next_retry_at": None,
            "processed_at": utc_now(),
        },
    )
    log("interaction actioned", interaction_id=interaction.id, intent=classification.intent)


def main() -> None:
    shadow_mode = env_bool("SHADOW_MODE", True)
    batch_size = env_int("INTERACTION_BATCH_SIZE", 10, maximum=100)
    max_attempts = env_int("MAX_ATTEMPTS", 5, maximum=20)

    database = SupabaseClient(SupabaseSettings.from_env())
    whatsapp_link = os.getenv("WHATSAPP_CONTACT_LINK", "").strip()
    if not shadow_mode and not whatsapp_link:
        whatsapp_link = required_env("WHATSAPP_CONTACT_LINK")
    classifier = Classifier(GroqClient(GroqSettings.from_env()), whatsapp_link)
    threads = ThreadsClient(ThreadsSettings.from_env()) if not shadow_mode else None
    telegram = TelegramClient(TelegramSettings.from_env()) if not shadow_mode else None

    interactions = database.claim_interactions(batch_size=batch_size, max_attempts=max_attempts)
    log("interaction batch claimed", count=len(interactions), shadow_mode=shadow_mode)
    failures = 0
    for interaction in interactions:
        try:
            process_one(
                interaction,
                classifier=classifier,
                database=database,
                shadow_mode=shadow_mode,
                threads=threads,
                telegram=telegram,
            )
        except Exception as error:
            failures += 1
            log("interaction processing failed", interaction_id=interaction.id, error=str(error))
            database.mark_interaction_failed(interaction.id, str(error), max_attempts=max_attempts)

    if failures:
        raise SystemExit(f"{failures} interaction(s) failed")


if __name__ == "__main__":
    main()
