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

const BANNED_COPY_MARKERS = [
  "играет важную роль",
  "является свидетельством",
  "подчёркивает",
  "подчеркивает",
  "многогранн",
  "путешествие",
  "по-настоящему",
  "по настоящему",
  "безусловно",
  "более того",
  "кроме того",
  "таким образом",
  "стоит отметить",
];

const ALLOWED_LATIN_WORDS = new Set([
  "ai",
  "google",
  "instagram",
  "mononyx",
  "roi",
  "telegram",
  "threads",
  "whatsapp",
]);

const PRICE_SERVICE_RULES: Record<string, { label: string; pattern: RegExp }> = {
  "49990": { label: "лендинг", pattern: /лендинг/iu },
  "89990": { label: "многостраничный сайт", pattern: /многостраничн/iu },
  "200000": {
    label: "WhatsApp/Telegram-бот",
    pattern: /(?:бот|автоматизац)/iu,
  },
};

const PRICE_FOCUSED_ANGLE = /(?:цен|стоимост|бюджет|подрядчик|лендинг, а когда многостраничный)/iu;
const OUTCOME_PROMISE =
  /(?:принес[её]т|даст|обеспечит|увеличит|поднимет|привед[её]т)[\s\S]{0,60}(?:заявк|продаж|клиент|roi)/iu;
const GENERIC_POST_PHRASES = [
  "мы можем помочь",
  "действительно",
  "получить результат",
  "сервисные бизнесы",
  "контент и функционал",
  "слишком много кликать",
  "как будет обеспечена поддержка",
];
const ACQUISITION_CLAIM = /привлеч\p{L}*\s+(?:заявк|клиент)/iu;
const SPLIT_NASKOLKO = /(?:^|[^\p{L}])на\s+сколько\s+(?:глубоко|быстро|удобно)(?:$|[^\p{L}])/iu;
const AMBIGUOUS_BOT_HOURS = /(?:^|[^\p{L}])после\s+часа\s+работы\s+бота(?:$|[^\p{L}])/iu;

interface NumericMention {
  normalized: string;
  index: number;
}

function numericMentions(text: string): NumericMention[] {
  const pattern = /\d{1,3}(?:[ .,\u00a0\u202f]\d{3})+|\d+/gu;
  return Array.from(text.matchAll(pattern), (match) => ({
    normalized: match[0].replace(/\D/gu, ""),
    index: match.index ?? 0,
  }));
}

function surroundingContext(text: string, index: number, radius = 120): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

export function assertGeneratedCopy(text: string, businessContext: string): void {
  const normalizedText = text.toLocaleLowerCase("ru");
  const marker = BANNED_COPY_MARKERS.find((value) => normalizedText.includes(value));
  if (marker) throw new Error(`Generated copy contains banned wording: ${marker}`);
  if (/не\s+просто\b[\s\S]{0,120}\bа\b/iu.test(text)) {
    throw new Error("Generated copy contains a banned artificial contrast");
  }

  for (const match of text.matchAll(/\p{Script=Latin}+/gu)) {
    const word = match[0].toLocaleLowerCase("en");
    if (!ALLOWED_LATIN_WORDS.has(word)) {
      throw new Error(`Generated copy contains an unsupported Latin word: ${word}`);
    }
  }

  const allowedNumbers = new Set(
    numericMentions(businessContext).map((mention) => mention.normalized),
  );
  for (const mention of numericMentions(text)) {
    if (!allowedNumbers.has(mention.normalized)) {
      throw new Error(`Generated copy contains an unsupported number: ${mention.normalized}`);
    }
    const prefix = text.slice(Math.max(0, mention.index - 20), mention.index);
    if (!/(?:^|[\s([{"«])от[\s:–—-]*$/iu.test(prefix)) {
      throw new Error("Generated copy mentions a price without the required 'от' qualifier");
    }
    const serviceRule = PRICE_SERVICE_RULES[mention.normalized];
    if (
      serviceRule &&
      !serviceRule.pattern.test(surroundingContext(text, mention.index))
    ) {
      throw new Error(
        `Generated copy uses the ${mention.normalized} price without naming ${serviceRule.label}`,
      );
    }
  }
}

export function assertGeneratedPostCopy(
  text: string,
  businessContext: string,
  contentAngle: string,
): void {
  assertGeneratedCopy(text, businessContext);

  if (OUTCOME_PROMISE.test(text)) {
    throw new Error("Generated post promises an uncontrolled business outcome");
  }

  if (ACQUISITION_CLAIM.test(text)) {
    throw new Error("Generated post implies that the service will attract leads or clients");
  }

  if (SPLIT_NASKOLKO.test(text)) {
    throw new Error("Generated post contains the split spelling 'на сколько'");
  }

  if (AMBIGUOUS_BOT_HOURS.test(text)) {
    throw new Error("Generated post contains an ambiguous bot-hours phrase");
  }

  const normalizedText = text.toLocaleLowerCase("ru");
  const genericPhrase = GENERIC_POST_PHRASES.find((phrase) => normalizedText.includes(phrase));
  if (genericPhrase) {
    throw new Error(`Generated post contains generic sales wording: ${genericPhrase}`);
  }

  if (numericMentions(text).length > 0 && !PRICE_FOCUSED_ANGLE.test(contentAngle)) {
    throw new Error("Generated post mentions prices outside a price-focused content angle");
  }
}

export interface GroqClassification {
  intent: Intent;
  signals: string[];
  riskFlags: string[];
  proposedReply: string | null;
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export interface PostGenerationRequest {
  businessContext: string;
  targetAudience: string;
  toneOfVoice: string;
  contentAngle: string;
  scheduledAt: string;
  recentPosts: string[];
}

export function fitThreadsText(text: string, maximum = 500): string {
  const normalized = text
    .trim()
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  const characters = Array.from(normalized);
  if (characters.length <= maximum) return normalized;

  const candidate = characters.slice(0, maximum + 1).join("");
  const punctuation = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf(".\n"),
    candidate.lastIndexOf("!\n"),
    candidate.lastIndexOf("?\n"),
  );
  const whitespace = candidate.lastIndexOf(" ");
  const cutAt = punctuation >= Math.floor(maximum * 0.6)
    ? punctuation + 1
    : whitespace >= Math.floor(maximum * 0.6)
    ? whitespace
    : maximum;
  return Array.from(candidate.slice(0, cutAt).trim()).slice(0, maximum).join("");
}

export class GroqClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(text: string, businessContext = ""): Promise<GroqClassification> {
    const system = [
      "Ты классификатор входящих сообщений для веб- и digital-агентства.",
      "Верни только JSON с полями intent, signals, risk_flags, proposed_reply.",
      "intent: lead, engagement или spam.",
      "signals: explicit_need, vendor_search, pricing, timeline, contact_intent, service_interest, conversation, praise, promotion, irrelevant.",
      "risk_flags: aggression, complaint, legal, reputation, personal_data.",
      "Не выдумывай факты. proposed_reply должен быть живым, коротким, на одно-два предложения, мягким и без обещаний.",
      "Не используй канцелярит, самопересказ, искусственный контраст «не просто X, а Y» и отполированный рекламный тон.",
      businessContext
        ? "Если это лид, составь proposed_reply только на основе контекста бизнеса ниже. Ответь по существу или задай один уточняющий вопрос. Цены можно брать только из контекста и упоминать только с формулировкой «от». Не придумывай другие цифры, сроки, кейсы и гарантии."
        : "",
      businessContext ? `Контекст бизнеса:\n${businessContext.slice(0, 12_000)}` : "",
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
    let proposedReply = typeof parsed.proposed_reply === "string"
      ? parsed.proposed_reply.trim().slice(0, 450) || null
      : null;
    if (proposedReply && businessContext) {
      try {
        assertGeneratedCopy(proposedReply, businessContext);
      } catch (error) {
        proposedReply = null;
        console.warn(JSON.stringify({
          event: "generated_reply_rejected",
          reason: error instanceof Error ? error.message : "Unknown copy validation error",
        }));
      }
    }

    return { intent, signals, riskFlags, proposedReply };
  }

  async generatePost(request: PostGenerationRequest): Promise<string> {
    const system = [
      "Ты редактор Threads для веб- и digital-агентства.",
      "Напиши один самостоятельный пост на русском языке, который привлекает релевантных клиентов пользой, а не агрессивной продажей.",
      "Формат: сильный конкретный хук, одна полезная мысль или наблюдение, мягкий CTA или вопрос.",
      "Используй только факты из профиля бизнеса. Цены можно брать только из профиля и упоминать только с формулировкой «от». Не выдумывай другие цифры, кейсы, клиентов, сроки, личные истории и гарантии.",
      "Упоминай цены только тогда, когда контентный ракурс прямо связан с ценой, стоимостью, бюджетом или выбором подрядчика. В остальных постах не перечисляй услуги и цены.",
      "Каждую цену связывай с точной услугой в том же фрагменте текста: 49 990 ₸ — только лендинг, 89 990 ₸ — только многостраничный сайт, 200 000 ₸ — только WhatsApp/Telegram-бот. Для мобильного приложения числовую цену не называй.",
      "Не обещай заявки, продажи, клиентов, рост или окупаемость. Не пиши общие фразы «мы можем помочь» и «действительно работает». Давай конкретную проверку, наблюдение или вопрос по заданному ракурсу.",
      "В посте должна быть хотя бы одна конкретная деталь, которую предприниматель сможет проверить или применить: элемент страницы, вопрос подрядчику, повторяющийся процесс или пример пользовательского действия. Не заменяй конкретику словами «контент», «функционал» и «получить результат».",
      "Пиши «компании сферы услуг» или называй конкретную нишу. Не используй выражение «сервисный бизнес». Не используй слово «действительно».",
      "Перед ответом проверь русскую грамматику и отсутствие случайных латинских букв внутри русских слов. В вопросе о степени пиши «насколько» слитно. Не используй двусмысленную фразу «после часа работы бота» и канцелярскую конструкцию «как будет обеспечена поддержка».",
      "Не пиши, что ты ИИ. Не используй кликбейт, канцелярит, самопересказ, искусственный контраст «не просто X, а Y», идеально отполированный рекламный тон и россыпь хэштегов.",
      "Не используй выражения: «играет важную роль», «является свидетельством», «подчёркивает», «многогранный», «путешествие» как метафору, «по-настоящему», «безусловно», «более того», «кроме того», «таким образом», «стоит отметить».",
      'Верни только JSON вида {"text":"..."}. Максимум 500 символов с пробелами.',
    ].join(" ");
    const recent = request.recentPosts.length > 0
      ? request.recentPosts.map((post, index) => `${index + 1}. ${post}`).join("\n")
      : "нет";
    const user = [
      `Профиль бизнеса:\n${request.businessContext.slice(0, 12_000)}`,
      `Целевая аудитория:\n${request.targetAudience.slice(0, 4_000)}`,
      `Тон:\n${request.toneOfVoice.slice(0, 2_000)}`,
      `Контентный ракурс для этого поста:\n${request.contentAngle}`,
      `Недавние посты, темы и формулировки которых нельзя повторять:\n${recent.slice(0, 6_000)}`,
    ].join("\n\n");

    let rejectionReason = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const correction = rejectionReason
        ? `\n\nПредыдущий вариант отклонён контролем качества: ${rejectionReason}. Напиши новый вариант и исправь эту ошибку.`
        : "";
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
            temperature: 0.7,
            max_completion_tokens: 500,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: system },
              { role: "user", content: `${user}${correction}` },
            ],
          }),
        },
      );

      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("Groq API returned no generated post");

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new Error("Groq API returned invalid generated post JSON");
      }
      if (typeof parsed.text !== "string" || !parsed.text.trim()) {
        throw new Error("Groq API returned an empty generated post");
      }
      const text = fitThreadsText(parsed.text);
      if (Array.from(text).length < 40) {
        rejectionReason = "пост короче 40 символов";
      } else {
        try {
          assertGeneratedPostCopy(text, request.businessContext, request.contentAngle);
          return text;
        } catch (error) {
          rejectionReason = error instanceof Error ? error.message : "неизвестная ошибка текста";
        }
      }
    }

    throw new Error(`Groq API generated invalid copy three times: ${rejectionReason}`);
  }
}
