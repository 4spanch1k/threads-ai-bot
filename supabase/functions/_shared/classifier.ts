import type { GroqClient } from "./groq.ts";
import type { Classification, ConfidenceLevel, Intent } from "./types.ts";

const SIGNAL_SCORES: Record<string, [Intent, number]> = {
  explicit_need: ["lead", 4],
  vendor_search: ["lead", 4],
  pricing: ["lead", 2],
  timeline: ["lead", 1],
  contact_intent: ["lead", 2],
  service_interest: ["lead", 1],
  conversation: ["engagement", 2],
  praise: ["engagement", 2],
  promotion: ["spam", 4],
  irrelevant: ["spam", 2],
};

const LEAD_NEED_PHRASES = [
  "нужен сайт",
  "нужна разработка",
  "нужно приложение",
  "нужна автоматизация",
  "хочу сайт",
  "сделать сайт",
  "разработать сайт",
  "сайт керек",
  "қосымша керек",
];
const VENDOR_SEARCH_PHRASES = [
  "ищу разработчика",
  "ищу подрядчика",
  "кто сделает сайт",
  "посоветуйте разработчика",
  "әзірлеуші іздеймін",
];
const SERVICE_TERMS = [
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
];
const PRICING_PHRASES = [
  "сколько стоит",
  "какая цена",
  "стоимость",
  "цена разработки",
  "қанша тұрады",
];
const TIMELINE_PHRASES = ["срочно", "на этой неделе", "за месяц", "срок", "дедлайн", "шұғыл"];
const CONTACT_PHRASES = [
  "напишите мне",
  "свяжитесь",
  "оставлю номер",
  "whatsapp",
  "телеграм",
  "telegram",
];
const NEGATIONS = ["не нужен", "не нужна", "не нужно", "не ищу"];
const SPAM_PHRASES = [
  "заработок без вложений",
  "крипто сигнал",
  "гарантированный доход",
  "подпишись на канал",
  "накрутка подписчиков",
  "casino",
  "казино",
];
const RISK_PATTERNS: Record<string, string[]> = {
  aggression: ["идиот", "тупые", "ненавижу", "заткнись", "уроды"],
  complaint: ["жалоба", "обманули", "мошенники", "верните деньги", "ужасный сервис"],
  legal: ["подам в суд", "юрист", "претензия", "нарушение закона", "судеб"],
  reputation: ["опубликую отзыв", "разнесу в соцсетях", "репутац"],
};

function containsAny(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

export function localEvidence(text: string): { signals: Set<string>; risks: Set<string> } {
  const normalized = text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const signals = new Set<string>();
  const risks = new Set<string>();
  for (const [flag, patterns] of Object.entries(RISK_PATTERNS)) {
    if (containsAny(normalized, patterns)) risks.add(flag);
  }
  const negated = containsAny(normalized, NEGATIONS);

  if (!negated && containsAny(normalized, LEAD_NEED_PHRASES)) signals.add("explicit_need");
  if (!negated && containsAny(normalized, VENDOR_SEARCH_PHRASES)) signals.add("vendor_search");
  if (containsAny(normalized, SERVICE_TERMS)) signals.add("service_interest");
  if (containsAny(normalized, PRICING_PHRASES)) signals.add("pricing");
  if (containsAny(normalized, TIMELINE_PHRASES)) signals.add("timeline");
  if (containsAny(normalized, CONTACT_PHRASES)) signals.add("contact_intent");
  if (containsAny(normalized, SPAM_PHRASES)) signals.add("promotion");
  if (
    text.includes("?") ||
    ["как ", "что ", "почему ", "спасибо", "класс", "интересно"].some((prefix) =>
      normalized.startsWith(prefix)
    )
  ) signals.add("conversation");
  if (containsAny(normalized, ["круто", "отлично", "полезно", "спасибо", "супер"])) {
    signals.add("praise");
  }
  return { signals, risks };
}

function scores(signals: Iterable<string>): Record<Intent, number> {
  const result: Record<Intent, number> = { lead: 0, engagement: 0, spam: 0 };
  for (const signal of signals) {
    const scoring = SIGNAL_SCORES[signal];
    if (scoring) result[scoring[0]] += scoring[1];
  }
  return result;
}

function winningIntent(values: Record<Intent, number>): Intent {
  return (Object.entries(values) as Array<[Intent, number]>).reduce(
    (best, current) => current[1] > best[1] ? current : best,
  )[0];
}

function confidence(values: Record<Intent, number>, winner: Intent): ConfidenceLevel {
  const ordered = Object.values(values).sort((left, right) => right - left);
  const top = values[winner];
  const margin = top - ordered[1];
  if (top >= 5 && margin >= 2) return "high";
  if (top >= 3 && margin >= 1) return "medium";
  return "low";
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export class Classifier {
  constructor(
    private readonly groq: Pick<GroqClient, "classify">,
    private readonly whatsappContactLink = "",
  ) {}

  async classify(text: string): Promise<Classification> {
    const { signals: localSignals, risks: localRisks } = localEvidence(text);
    const localScores = scores(localSignals);

    if (localRisks.size > 0) {
      const riskIntent = Object.values(localScores).some(Boolean)
        ? winningIntent(localScores)
        : "engagement";
      return this.result(riskIntent, localSignals, localRisks, "low", null);
    }
    if (localScores.spam >= 4) return this.result("spam", localSignals, [], "high", null);
    if (localScores.lead >= 5) {
      return this.result("lead", localSignals, [], "high", this.leadReply());
    }
    if (localScores.lead >= 3 && localScores.lead > localScores.engagement) {
      return this.result("lead", localSignals, [], "medium", this.leadReply());
    }
    if (localScores.engagement >= 4 && localScores.lead === 0) {
      return this.result(
        "engagement",
        localSignals,
        [],
        "high",
        "Спасибо! Рады, что было полезно 🙌",
      );
    }

    const evidence = await this.groq.classify(text);
    const combinedSignals = new Set([...localSignals, ...evidence.signals]);
    const combinedRisks = new Set([...localRisks, ...evidence.riskFlags]);
    const combinedScores = scores(combinedSignals);
    combinedScores[evidence.intent] += 1;
    const winner = winningIntent(combinedScores);
    let reply: string | null = null;
    if (combinedRisks.size === 0) {
      if (winner === "lead") reply = this.leadReply();
      if (winner === "engagement") reply = evidence.proposedReply ?? "Спасибо за комментарий!";
    }

    return this.result(
      winner,
      combinedSignals,
      combinedRisks,
      confidence(combinedScores, winner),
      reply,
    );
  }

  private leadReply(): string {
    const link = this.whatsappContactLink.trim();
    return link
      ? `Похоже, здесь можем помочь. Напишите пару деталей в WhatsApp — посмотрим задачу без навязчивых продаж: ${link}`
      : "Похоже, здесь можем помочь. Напишите пару деталей — спокойно посмотрим задачу.";
  }

  private result(
    intent: Intent,
    signals: Iterable<string>,
    risks: Iterable<string>,
    confidenceLevel: ConfidenceLevel,
    botReplyText: string | null,
  ): Classification {
    return {
      intent,
      signals: sorted(signals),
      riskFlags: sorted(risks),
      confidenceLevel,
      botReplyText,
    };
  }
}
