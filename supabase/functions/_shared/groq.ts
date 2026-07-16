import { fetchJson } from "./http.ts";
import type { Intent } from "./types.ts";

const ALLOWED_SIGNALS = new Set([
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
]);

const ALLOWED_RISKS = new Set([
  "aggression",
  "complaint",
  "legal",
  "reputation",
  "personal_data",
]);

export interface GroqClassification {
  intent: Intent;
  signals: string[];
  riskFlags: string[];
  proposedReply: string | null;
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class GroqClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(text: string): Promise<GroqClassification> {
    const system = [
      "Ты классификатор входящих сообщений для веб- и digital-агентства.",
      "Верни только JSON с полями intent, signals, risk_flags, proposed_reply.",
      "intent: lead, engagement или spam.",
      "signals: explicit_need, vendor_search, pricing, timeline, contact_intent, service_interest, conversation, praise, promotion, irrelevant.",
      "risk_flags: aggression, complaint, legal, reputation, personal_data.",
      "Не выдумывай факты. proposed_reply должен быть коротким, мягким и без обещаний.",
    ].join(" ");

    const payload = await fetchJson<GroqResponse>(
      "Groq API",
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_completion_tokens: 350,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: text.slice(0, 2000) },
          ],
        }),
      },
    );

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq API returned no classification");

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error("Groq API returned invalid classification JSON");
    }

    const intent = parsed.intent;
    if (intent !== "lead" && intent !== "engagement" && intent !== "spam") {
      throw new Error("Groq API returned an unsupported intent");
    }

    const signals = Array.isArray(parsed.signals)
      ? parsed.signals.filter((value): value is string =>
        typeof value === "string" && ALLOWED_SIGNALS.has(value)
      )
      : [];
    const riskFlags = Array.isArray(parsed.risk_flags)
      ? parsed.risk_flags.filter((value): value is string =>
        typeof value === "string" && ALLOWED_RISKS.has(value)
      )
      : [];
    const proposedReply = typeof parsed.proposed_reply === "string"
      ? parsed.proposed_reply.trim().slice(0, 450) || null
      : null;

    return { intent, signals, riskFlags, proposedReply };
  }
}
