from __future__ import annotations

import unittest
from collections.abc import Mapping
from typing import Any

from bot.jobs.process_interactions import process_one, should_notify, should_reply
from bot.models import Classification, Interaction


class FakeDatabase:
    def __init__(self) -> None:
        self.updates: list[tuple[str, dict[str, Any]]] = []

    def update_interaction(self, interaction_id: str, values: Mapping[str, Any]) -> None:
        self.updates.append((interaction_id, dict(values)))


class FakeClassifier:
    def classify(self, text: str) -> Classification:
        return Classification(
            intent="lead",
            signals=("explicit_need", "service_interest"),
            risk_flags=(),
            confidence_level="high",
            bot_reply_text="Напишите нам",
        )


def interaction(*, source: str = "own_reply") -> Interaction:
    return Interaction(
        id="interaction-1",
        source_item_id="reply:reply-1",
        source=source,
        event_type="reply",
        comment_text="Нужен сайт",
        post_id="post-1",
        username="prospect",
        intent=None,
        signals=(),
        risk_flags=(),
        confidence_level=None,
        bot_reply_text=None,
        reply_sent=False,
        notification_sent=False,
    )


class ProcessorTests(unittest.TestCase):
    def test_shadow_mode_only_persists_classification(self) -> None:
        database = FakeDatabase()

        process_one(
            interaction(),
            classifier=FakeClassifier(),
            database=database,
            shadow_mode=True,
            threads=None,
            telegram=None,
        )

        self.assertEqual(len(database.updates), 1)
        self.assertEqual(database.updates[0][1]["status"], "classified")
        self.assertNotIn("reply_sent", database.updates[0][1])
        self.assertNotIn("notification_sent", database.updates[0][1])

    def test_keyword_hits_never_auto_reply(self) -> None:
        classification = Classification("lead", (), (), "high", "CTA")
        self.assertFalse(should_reply(interaction(source="keyword_search"), classification))
        self.assertTrue(should_notify(interaction(source="keyword_search"), classification))

    def test_risk_always_routes_to_manual_notification(self) -> None:
        classification = Classification("engagement", (), ("complaint",), "high", None)
        self.assertFalse(should_reply(interaction(), classification))
        self.assertTrue(should_notify(interaction(), classification))


if __name__ == "__main__":
    unittest.main()
