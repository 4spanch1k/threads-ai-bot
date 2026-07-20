from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Protocol

from bot.groq import GroqEvidence
from bot.models import Classification, Confidence, Intent


class EvidenceClient(Protocol):
    def classify(self, text: str) -> GroqEvidence: ...

SIGNAL_SCORES: dict[str, tuple[Intent, int]] = {
    "explicit_need": ("lead", 4),
    "vendor_search": ("lead", 4),
    "pricing": ("lead", 2),
    "timeline": ("lead", 1),
    "contact_intent": ("lead", 2),
    "service_interest": ("lead", 1),
    "conversation": ("engagement", 2),
    "praise": ("engagement", 2),
    "promotion": ("spam", 4),
    "irrelevant": ("spam", 2),
}

LEAD_NEED_PHRASES = (
    "нужен сайт",
    "нужен лендинг",
    "нужен бот",
    "нужна разработка",
    "нужно приложение",
    "нужна автоматизация",
    "хочу сайт",
    "хочу лендинг",
    "хочу заказать",
    "хотим сайт",
    "нужно сделать сайт",
    "сделать сайт",
    "разработать сайт",
    "сайт керек",
    "қосымша керек",
)
VENDOR_SEARCH_PHRASES = (
    "ищу разработчика",
    "ищу подрядчика",
    "кто сделает сайт",
    "посоветуйте разработчика",
    "әзірлеуші іздеймін",
)
SERVICE_TERMS = (
    "сайт",
    "лендинг",
    "интернет-магазин",
    "приложение",
    "автоматизац",
    "crm",
    "бот",
    "дизайн",
    "разработ",
    "website",
    "app",
)
PRICING_PHRASES = ("сколько стоит", "какая цена", "стоимость", "цена разработки", "қанша тұрады")
TIMELINE_PHRASES = ("срочно", "на этой неделе", "за месяц", "срок", "дедлайн", "шұғыл")
CONTACT_PHRASES = ("напишите мне", "свяжитесь", "оставлю номер", "whatsapp", "телеграм", "telegram")
NEGATIONS = ("не нужен", "не нужна", "не нужно", "не ищу")
DIRECT_SERVICE_QUESTION = re.compile(
    r"(?:сколько\s+стоит|какая\s+цена|стоимость|какой\s+срок|как\s+заказать|что\s+входит|"
    r"что\s+нужно|чем\s+отличается|как\s+проходит|можно\s+(?:ли|подробнее)|"
    r"сможете|возьм[её]тесь|вы\s+(?:делаете|разрабатываете|собираете|настраиваете))[^?]{0,160}\?",
    re.IGNORECASE,
)
FIRST_PERSON_SERVICE_NEED = re.compile(
    r"\b(?:мне|нам|мы|я|хочу|хотим|планирую|планируем|у\s+нас)\b[^.!?]{0,100}"
    r"(?:сайт|лендинг|интернет-магазин|приложени\w*|автоматизац\w*|crm|бот\w*|дизайн|разработк\w*)",
    re.IGNORECASE,
)
SPAM_PHRASES = (
    "заработок без вложений",
    "крипто сигнал",
    "гарантированный доход",
    "подпишись на канал",
    "накрутка подписчиков",
    "casino",
    "казино",
)
RISK_PATTERNS: dict[str, tuple[str, ...]] = {
    "aggression": ("идиот", "тупые", "ненавижу", "заткнись", "уроды"),
    "complaint": ("жалоба", "обманули", "мошенники", "верните деньги", "ужасный сервис"),
    "legal": ("подам в суд", "юрист", "претензия", "нарушение закона", "судеб"),
    "reputation": ("опубликую отзыв", "разнесу в соцсетях", "репутац"),
}


def _contains_any(text: str, phrases: Iterable[str]) -> bool:
    return any(phrase in text for phrase in phrases)


def _local_signals(text: str) -> tuple[set[str], set[str]]:
    normalized = re.sub(r"\s+", " ", text.casefold()).strip()
    signals: set[str] = set()
    risks = {flag for flag, patterns in RISK_PATTERNS.items() if _contains_any(normalized, patterns)}
    negated = _contains_any(normalized, NEGATIONS)

    if not negated and _contains_any(normalized, LEAD_NEED_PHRASES):
        signals.add("explicit_need")
    if not negated and _contains_any(normalized, VENDOR_SEARCH_PHRASES):
        signals.add("vendor_search")
    if _contains_any(normalized, SERVICE_TERMS):
        signals.add("service_interest")
    if _contains_any(normalized, PRICING_PHRASES):
        signals.add("pricing")
    if _contains_any(normalized, TIMELINE_PHRASES):
        signals.add("timeline")
    if _contains_any(normalized, CONTACT_PHRASES):
        signals.add("contact_intent")
    if _contains_any(normalized, SPAM_PHRASES):
        signals.add("promotion")
    if "?" in text or normalized.startswith(("как ", "что ", "почему ", "спасибо", "класс", "интересно")):
        signals.add("conversation")
    if _contains_any(normalized, ("круто", "отлично", "полезно", "спасибо", "супер")):
        signals.add("praise")
    return signals, risks


def is_direct_commercial_message(text: str) -> bool:
    signals, _ = _local_signals(text)
    if {"explicit_need", "vendor_search"} & signals:
        return True
    if FIRST_PERSON_SERVICE_NEED.search(text):
        return True
    if "service_interest" in signals and DIRECT_SERVICE_QUESTION.search(text):
        return True
    return "?" in text and bool({"pricing", "timeline", "contact_intent"} & signals)


def _scores(signals: Iterable[str]) -> dict[Intent, int]:
    result: dict[Intent, int] = {"lead": 0, "engagement": 0, "spam": 0}
    for signal in signals:
        scoring = SIGNAL_SCORES.get(signal)
        if scoring:
            intent, points = scoring
            result[intent] += points
    return result


def _confidence(scores: dict[Intent, int], winner: Intent) -> Confidence:
    ordered = sorted(scores.values(), reverse=True)
    top = scores[winner]
    margin = top - ordered[1]
    if top >= 5 and margin >= 2:
        return "high"
    if top >= 3 and margin >= 1:
        return "medium"
    return "low"


class Classifier:
    def __init__(self, groq: EvidenceClient, whatsapp_contact_link: str = "") -> None:
        self.groq = groq
        self.whatsapp_contact_link = whatsapp_contact_link.strip()

    def classify(self, text: str) -> Classification:
        local_signals, local_risks = _local_signals(text)
        local_scores = _scores(local_signals)

        if local_risks:
            risk_intent: Intent = max(local_scores, key=local_scores.get) if any(local_scores.values()) else "engagement"
            return Classification(
                intent=risk_intent,
                signals=tuple(sorted(local_signals)),
                risk_flags=tuple(sorted(local_risks)),
                confidence_level="low",
                bot_reply_text=None,
            )
        if local_scores["spam"] >= 4:
            return self._result("spam", local_signals, (), "high", None)
        if local_scores["lead"] >= 5:
            return self._result("lead", local_signals, (), "high", self._lead_reply())
        if local_scores["lead"] >= 3 and local_scores["lead"] > local_scores["engagement"]:
            return self._result("lead", local_signals, (), "medium", self._lead_reply())
        if local_scores["engagement"] >= 4 and local_scores["lead"] == 0:
            return self._result(
                "engagement",
                local_signals,
                (),
                "high",
                "Спасибо! Рады, что было полезно 🙌",
            )

        evidence = self.groq.classify(text)
        direct_commercial_message = is_direct_commercial_message(text)
        evidence_signals = set(evidence.signals)
        if not direct_commercial_message:
            evidence_signals -= {"explicit_need", "vendor_search", "contact_intent"}
        signals = local_signals | evidence_signals
        risks = local_risks | set(evidence.risk_flags)
        if not direct_commercial_message and evidence.intent != "spam":
            signals.add("conversation")
            return self._result("engagement", signals, risks, "high", None)
        scores = _scores(signals)
        scores[evidence.intent] += 1
        winner = max(scores, key=scores.get)
        confidence = _confidence(scores, winner)
        reply = None
        if not risks:
            if winner == "lead":
                reply = self._lead_reply()

        return self._result(winner, signals, risks, confidence, reply)

    def _lead_reply(self) -> str:
        if self.whatsapp_contact_link:
            return (
                "Похоже, здесь можем помочь. Напишите пару деталей в WhatsApp — "
                f"посмотрим задачу без навязчивых продаж: {self.whatsapp_contact_link}"
            )
        return "Похоже, здесь можем помочь. Напишите пару деталей — спокойно посмотрим задачу."

    @staticmethod
    def _result(
        intent: Intent,
        signals: Iterable[str],
        risks: Iterable[str],
        confidence: Confidence,
        reply: str | None,
    ) -> Classification:
        return Classification(
            intent=intent,
            signals=tuple(sorted(set(signals))),
            risk_flags=tuple(sorted(set(risks))),
            confidence_level=confidence,
            bot_reply_text=reply,
        )
