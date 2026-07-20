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
  "в современном мире",
  "ни для кого не секрет",
  "вы когда-нибудь задумывались",
  "давайте разберёмся",
  "важно понимать",
  "ключевую роль",
  "вывести бизнес на новый уровень",
  "мощный инструмент продаж",
  "уникальное решение",
  "инновационный подход",
  "открывает новые возможности",
  "максимизировать эффективность",
  "повысить узнаваемость",
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
  "подводя итог",
  "в заключение",
  "готовы начать",
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
  /(?:принес[её]т|принос\p{L}*|даст|обеспечит|увеличит|поднимет|привед[её]т)[\s\S]{0,60}(?:заявк|продаж|клиент|roi)/iu;
const GUARANTEED_BUSINESS_OUTCOME =
  /гарант\p{L}*[\s\S]{0,60}(?:продаж|заявк|клиент|рост|roi|окупаем)/iu;
const SEARCH_RANKING_PROMISE =
  /(?:(?:вывед|подним|попад|окаж|буд)\p{L}*[\s\S]{0,50}(?:топ|перв\p{L}*\s+(?:мест|позици|страниц))|(?:топ|перв\p{L}*\s+(?:мест|позици|страниц))[\s\S]{0,50}(?:гарант|обеспеч|вывед|подним|попад|окаж|буд)\p{L}*)[\s\S]{0,50}(?:google|гугл|поиск)/iu;
const GUARANTEED_TIMELINE =
  /(?:гарант\p{L}*[\s\S]{0,50}(?:срок|дн|недел|месяц)|(?:сделаем|запустим|сдадим|будет готов)\p{L}*[\s\S]{0,30}\bза\s+\d+)/iu;
const LEGAL_OR_FINANCIAL_GUARANTEE =
  /(?:(?:юридическ|финансов)\p{L}*[\s\S]{0,50}гарант|гарант\p{L}*[\s\S]{0,50}(?:юридическ|финансов)\p{L}*)/iu;
const OFF_PLATFORM_CTA =
  /(?:подпиш(?:итесь|ись)|подписывай(?:тесь|ся)|переход(?:ите|и)|перейд(?:ите|и)|(?:пиш|напиш)(?:и|ите)\s+(?:мне\s+)?(?:в\s+)?(?:whatsapp|telegram|личк))/iu;
const GENERIC_POST_PHRASES = [
  "мы можем помочь",
  "действительно",
  "получить результат",
  "сервисные бизнесы",
  "контент и функционал",
  "слишком много кликать",
  "как будет обеспечена поддержка",
  "для бизнеса в казахстане",
  "какую основную цель вы хотели бы видеть",
  "какую основную проблему вы хотели бы решить",
  "потенциальный лендинг",
  "под задачу бизнеса",
  "пользовательский путь",
  "пользовательский сценарий",
  "согласованную задачу",
];
const ACQUISITION_CLAIM = /привлеч\p{L}*\s+(?:заявк|клиент)/iu;
const SPLIT_NASKOLKO = /(?:^|[^\p{L}])на\s+сколько\s+(?:глубоко|быстро|удобно)(?:$|[^\p{L}])/iu;
const AMBIGUOUS_BOT_HOURS = /(?:^|[^\p{L}])после\s+часа\s+работы\s+бота(?:$|[^\p{L}])/iu;
const SERVICE_MENTION =
  /(?:лендинг|сайт|мобильн\p{L}*\s+приложени\p{L}*|(?:whatsapp|telegram)[\s/-]*бот|бот\p{L}*|автоматизац\p{L}*)/iu;
const BUSINESS_TOPIC =
  /(?:бизнес|предпринимател|клиент|покупател|заказчик|менеджер|заявк|запис|услуг|цен|директ|whatsapp|telegram)/iu;
const GENERIC_ENGAGEMENT_QUESTION =
  /(?:что\s+(?:вы\s+)?(?:об\s+этом\s+)?думаете|согласны(?:\s+со\s+мной)?|как\s+вам(?:\s+такой)?|насколько[\s\S]{0,80}важн\p{L}*[^?]{0,80})[?!.\s]*$/iu;
const AGENCY_WORK =
  /(?:мы|команд\p{L}*|агентств\p{L}*|mononyx{1,2})[\s\S]{0,240}(?:бер[её]м|дела\p{L}*|созда\p{L}*|собира\p{L}*|проектир\p{L}*|разрабатыва\p{L}*|настраива\p{L}*|пересобира\p{L}*|упроща\p{L}*|сокраща\p{L}*|фиксир\p{L}*|автоматизир\p{L}*|превраща\p{L}*|запуска\p{L}*|помога\p{L}*|начина\p{L}*|отда[её]\p{L}*|убира\p{L}*|счита\p{L}*|разбира\p{L}*)/iu;
const SELLING_ANGLE = /формат:\s*продающ/iu;
const ADVERTISING_EMOJI = /[🚀🔥✨🎯📈✅💡]/u;
const EMOJI = /\p{Extended_Pictographic}/gu;
const SEARCH_VERB_GRAMMAR_ERROR = /(?:что|где)\s+(?:вы\s+)?(?:обычно\s+)?ищите(?:$|[^\p{L}])/iu;
const SIMILARITY_STOP_WORDS = new Set([
  "будет",
  "если",
  "когда",
  "который",
  "можно",
  "нужно",
  "обычно",
  "потом",
  "потому",
  "сами",
  "сразу",
  "только",
  "чтобы",
  "этого",
  "этот",
  "этой",
  "очень",
]);

export const MIN_GENERATED_POST_CHARACTERS = 35;
export const MAX_GENERATED_POST_CHARACTERS = 320;

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

function postTokens(text: string): Set<string> {
  const words = text.toLocaleLowerCase("ru").match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    words.filter((word) => word.length >= 4 && !SIMILARITY_STOP_WORDS.has(word)),
  );
}

export function isGeneratedPostTooSimilar(text: string, recentPosts: string[]): boolean {
  const candidate = postTokens(text);
  if (candidate.size < 3) return false;

  return recentPosts.some((recentPost) => {
    const recent = postTokens(recentPost);
    if (recent.size < 3) return false;
    let shared = 0;
    for (const token of candidate) {
      if (recent.has(token)) shared += 1;
    }
    return shared >= 3 && shared / Math.min(candidate.size, recent.size) >= 0.75;
  });
}

export function assertGeneratedCopy(text: string, businessContext: string): void {
  const normalizedText = text.toLocaleLowerCase("ru");
  const marker = BANNED_COPY_MARKERS.find((value) => normalizedText.includes(value));
  if (marker) throw new Error(`Generated copy contains banned wording: ${marker}`);
  if (/не\s+просто\b[\s\S]{0,120}\bа\b/iu.test(text)) {
    throw new Error("Generated copy contains a banned artificial contrast");
  }
  if (/(?:это\s+не|речь\s+не\s+о)\b[\s\S]{0,120}\bа\b/iu.test(text)) {
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
    const serviceRule = PRICE_SERVICE_RULES[mention.normalized];
    if (serviceRule) {
      const prefix = text.slice(Math.max(0, mention.index - 20), mention.index);
      if (!/(?:^|[\s([{"«])от[\s:–—-]*$/iu.test(prefix)) {
        throw new Error("Generated copy mentions a price without the required 'от' qualifier");
      }
      if (!serviceRule.pattern.test(surroundingContext(text, mention.index))) {
        throw new Error(
          `Generated copy uses the ${mention.normalized} price without naming ${serviceRule.label}`,
        );
      }
    }
  }
}

export function assertGeneratedReplyCopy(text: string, businessContext: string): void {
  assertGeneratedCopy(text, businessContext);

  if (OUTCOME_PROMISE.test(text) || ACQUISITION_CLAIM.test(text)) {
    throw new Error("Generated reply promises leads, clients, or sales");
  }
  if (GUARANTEED_BUSINESS_OUTCOME.test(text) || GUARANTEED_TIMELINE.test(text)) {
    throw new Error("Generated reply contains an unsupported guarantee");
  }
  if (SEARCH_RANKING_PROMISE.test(text) || LEGAL_OR_FINANCIAL_GUARANTEE.test(text)) {
    throw new Error("Generated reply contains an unsupported promise");
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

  if (LEGAL_OR_FINANCIAL_GUARANTEE.test(text)) {
    throw new Error("Generated post contains a legal or financial guarantee");
  }

  if (GUARANTEED_BUSINESS_OUTCOME.test(text)) {
    throw new Error("Generated post guarantees an uncontrolled business outcome");
  }

  if (ACQUISITION_CLAIM.test(text)) {
    throw new Error("Generated post implies that the service will attract leads or clients");
  }

  if (SEARCH_RANKING_PROMISE.test(text)) {
    throw new Error("Generated post promises an uncontrolled search ranking");
  }

  if (GUARANTEED_TIMELINE.test(text)) {
    throw new Error("Generated post guarantees a delivery timeline");
  }

  if (OFF_PLATFORM_CTA.test(text)) {
    throw new Error("Generated post contains an off-platform or subscription CTA");
  }

  if (SPLIT_NASKOLKO.test(text)) {
    throw new Error("Generated post contains the split spelling 'на сколько'");
  }

  if (AMBIGUOUS_BOT_HOURS.test(text)) {
    throw new Error("Generated post contains an ambiguous bot-hours phrase");
  }

  if (SEARCH_VERB_GRAMMAR_ERROR.test(text)) {
    throw new Error("Generated post uses 'ищите' instead of 'ищете'");
  }

  const normalizedText = text.toLocaleLowerCase("ru");
  const genericPhrase = GENERIC_POST_PHRASES.find((phrase) => normalizedText.includes(phrase));
  if (genericPhrase) {
    throw new Error(`Generated post contains generic sales wording: ${genericPhrase}`);
  }

  const containsKnownPrice = numericMentions(text).some((mention) =>
    mention.normalized in PRICE_SERVICE_RULES
  );
  if (containsKnownPrice && !PRICE_FOCUSED_ANGLE.test(contentAngle)) {
    throw new Error("Generated post mentions prices outside a price-focused content angle");
  }

  if (Array.from(text).length > MAX_GENERATED_POST_CHARACTERS) {
    throw new Error(`Generated post exceeds ${MAX_GENERATED_POST_CHARACTERS} characters`);
  }

  if (Array.from(text).length < MIN_GENERATED_POST_CHARACTERS) {
    throw new Error(`Generated post is shorter than ${MIN_GENERATED_POST_CHARACTERS} characters`);
  }

  if (!SERVICE_MENTION.test(text) && !BUSINESS_TOPIC.test(text)) {
    throw new Error("Generated post is outside the Mononyx business context");
  }

  if (GENERIC_ENGAGEMENT_QUESTION.test(text.trim())) {
    throw new Error("Generated post ends with a generic engagement question");
  }

  const questionMarks = Array.from(text).filter((character) => character === "?").length;
  if (questionMarks > 1) {
    throw new Error("Generated post contains more than one question");
  }

  if (text.includes("—")) {
    throw new Error("Generated post contains a long dash");
  }

  if (/#\p{L}+/u.test(text)) {
    throw new Error("Generated post contains a hashtag");
  }

  const emojiCount = Array.from(text.matchAll(EMOJI)).length;
  if (emojiCount > 2) {
    throw new Error("Generated post contains more than two emoji");
  }
  if (ADVERTISING_EMOJI.test(text)) {
    throw new Error("Generated post contains an advertising emoji");
  }

  const selling = SELLING_ANGLE.test(contentAngle);
  if (selling && !AGENCY_WORK.test(text)) {
    throw new Error("Selling post does not state what the agency does");
  }
  if (!selling && AGENCY_WORK.test(text)) {
    throw new Error("Non-selling post contains an agency offer");
  }
}

export function normalizeGeneratedPostCopy(text: string, _contentAngle: string): string {
  return text.trim();
}

export const POST_GENERATION_SYSTEM_PROMPT = [
  "Ты пишешь посты для Threads от лица живого человека из веб- и digital-агентства Mononyx в Казахстане. Агентство делает сайты, лендинги, мобильные приложения, AI-ботов и автоматизацию для бизнеса.",
  "Твоя задача не создавать контент по шаблону, а замечать знакомые, спорные или смешные ситуации предпринимателей и коротко высказываться так, чтобы хотелось ответить, согласиться или возразить.",
  "Одна публикация означает одну основную мысль. Пост может быть наблюдением, вопросом, спорным мнением, маленькой сценой или спокойным предложением услуги. Не пытайся совместить всё сразу.",
  "Пиши по-русски от 35 до 320 символов с пробелами. Варьируй длину и устройство: одна сильная фраза, две-три короткие строки, маленькая сцена или конкретный вопрос. Не повторяй формат, тему и начало недавних постов.",
  "Пиши как человек из современного интернета, а не копирайтер, преподаватель или корпоративный блог. Используй простые конкретные слова, короткие фразы и иногда разговорную шероховатость: «если честно», «по факту», «ну такое», «вот и думай». Не больше одного разговорного выражения на пост и не в каждом посте.",
  "Показывай проблему через действие: клиент ищет цену, не находит кнопку, ждёт ответа, повторяет один вопрос или получает квест вместо записи. Не объясняй очевидное и не закрывай каждую мысль идеальным выводом.",
  "Контентный ракурс содержит формат. Если формат наблюдение, обсуждение или мнение, не добавляй фразу о том, что делает Mononyx, и не продавай услугу. Если формат продающий, сначала покажи ситуацию, затем конкретную проблему, коротко скажи, что мы делаем, и дай один спокойный призыв.",
  "Не продавай в каждом посте. Не перечисляй все услуги сразу. Не дави, не создавай дефицит и не обещай результат. Нормальные призывы для продающего формата: «Могу показать демо», «Если актуально, напишите», «Можем разобрать ваш случай».",
  "Не заканчивай каждый пост вопросом. Если вопрос есть, он должен быть один, конкретный и такой, на который легко ответить из собственного опыта. Не используй «Что думаете?», «Согласны?» и «Как вам?» без контекста.",
  "Используй от нуля до двух эмодзи только для реакции или иронии. Подходят 😅, 👀, 🙂, 🤝, 🫠, 😂, 🤔, 🥲, 👍. Не используй рекламный набор 🚀, 🔥, ✨, 🎯, 📈, ✅, 💡.",
  "Не используй длинное тире, хэштеги, заголовок, формальный список и конструкцию «не просто X, а Y». Не группируй мысли по три ради красивой структуры.",
  "Хороший ритм: конкретная сцена, короткий поворот, реакция или точный вопрос. Например: «Владелец бизнеса отвечает клиенту через несколько часов и думает: “Ну я же ответил”. Ответил. Только клиент уже написал другому 😅». Или: «Сайт красивый. Цена в соцсетях, адрес на картах, запись в WhatsApp. Клиент хотел записаться, а получил квест 🫠».",
  "Личную историю, результат, число, клиента или случай из практики можно использовать только когда этот факт прямо указан в профиле бизнеса. Если подтверждения нет, не имитируй личный опыт и не выдумывай историю.",
  "Используй только факты из профиля бизнеса. Цены можно брать только из профиля и упоминать только с формулировкой «от». Не выдумывай другие цифры, кейсы, клиентов, сроки, личные истории и гарантии.",
  "Упоминай цены только тогда, когда контентный ракурс прямо связан с ценой, стоимостью или бюджетом. В остальных постах не называй цены.",
  "Каждую цену связывай с точной услугой в том же фрагменте текста: 49 990 ₸ только для лендинга, 89 990 ₸ только для многостраничного сайта, 200 000 ₸ только для WhatsApp/Telegram-бота. Для мобильного приложения числовую цену не называй.",
  "Не обещай позиции или топ в Google и других поисковиках. Не гарантируй сроки, продажи, заявки, клиентов, рост, ROI или окупаемость. Не давай юридических и финансовых гарантий.",
  "Если упоминаешь рекламу, продвижение, платные API или другие дополнительные расходы, прямо скажи, что это отдельная статья расходов и она не входит в стоимость разработки.",
  "Не пиши общие фразы «мы можем помочь» и «действительно работает». Не используй слова «цифровизация», «пользовательский сценарий», «пользовательский путь», «конверсия», «лидогенерация», «интеграция», «релевантный», «ключевой», «эффективный», «качественный» и «современный», если пользу можно показать действием. Не пиши «под задачу бизнеса» и «согласованная задача».",
  "Пиши «компании сферы услуг» или называй конкретную нишу. Не используй выражение «сервисный бизнес». Не используй слово «действительно».",
  "Перед ответом проверь русскую грамматику и отсутствие случайных латинских букв внутри русских слов. В вопросе о степени пиши «насколько» слитно. Не используй двусмысленную фразу «после часа работы бота» и канцелярскую конструкцию «как будет обеспечена поддержка».",
  "Не пиши, что ты ИИ. Не используй кликбейт, канцелярит, самопересказ и идеально отполированный рекламный тон.",
  "Не используй выражения: «в современном мире», «ни для кого не секрет», «вы когда-нибудь задумывались», «давайте разберёмся», «важно понимать», «играет важную роль», «является свидетельством», «подчёркивает», «многогранный», «путешествие» как метафору, «по-настоящему», «безусловно», «более того», «кроме того», «таким образом», «стоит отметить», «подводя итог», «в заключение», «готовы начать».",
  "Перед ответом молча проверь: это похоже на настоящую мысль человека, есть ли конкретика, можно ли убрать лишнюю фразу, нет ли пафоса и выдуманных фактов, хочется ли ответить или возразить.",
  'Верни только JSON вида {"text":"..."}. Не выходи за 320 символов с пробелами.',
].join(" ");

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
      "Lead — только когда автор говорит о своей текущей или планируемой задаче: явно ищет подрядчика, хочет заказать услугу, спрашивает цену, срок, состав услуги, как проходит работа, возможность или способ связаться.",
      "Шутка, сарказм, пересказ чужой мысли, критика, спор, общее мнение и простое упоминание сайта или разработки — engagement, а не lead. Если коммерческое намерение неясно, выбирай engagement.",
      "Не выдумывай факты. proposed_reply должен быть живым, коротким, на одно-два предложения, мягким и без обещаний.",
      "proposed_reply заполняй только для lead. Для engagement и spam всегда верни null.",
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
        assertGeneratedReplyCopy(proposedReply, businessContext);
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
    const system = POST_GENERATION_SYSTEM_PROMPT;
    const recent = request.recentPosts.length > 0
      ? request.recentPosts.map((post, index) => `${index + 1}. ${post}`).join("\n")
      : "нет";
    const user = [
      `Профиль бизнеса:\n${request.businessContext.slice(0, 12_000)}`,
      `Целевая аудитория:\n${request.targetAudience.slice(0, 4_000)}`,
      `Тон:\n${request.toneOfVoice.slice(0, 2_000)}`,
      `Контентный ракурс для этого поста:\n${request.contentAngle}`,
      `Недавние посты от самого нового к более старым. Не повторяй их темы, формулировки и тип хука; особенно не используй подряд тип хука из пункта 1:\n${
        recent.slice(0, 6_000)
      }`,
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
            max_completion_tokens: 300,
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
      const text = fitThreadsText(
        normalizeGeneratedPostCopy(parsed.text, request.contentAngle),
        MAX_GENERATED_POST_CHARACTERS,
      );
      if (Array.from(text).length < MIN_GENERATED_POST_CHARACTERS) {
        rejectionReason = `пост короче ${MIN_GENERATED_POST_CHARACTERS} символов`;
      } else if (isGeneratedPostTooSimilar(text, request.recentPosts)) {
        rejectionReason = "пост повторяет недавнюю публикацию по формулировке или смыслу";
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
