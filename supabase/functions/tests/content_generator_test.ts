import {
  fallbackPostForAngle,
  generateQueuedContent,
  pickContentAngle,
  planContentSlots,
} from "../content-generator/job.ts";
import {
  assertGeneratedCopy,
  assertGeneratedPostCopy,
  assertGeneratedReplyCopy,
  isGeneratedPostTooSimilar,
  MAX_GENERATED_POST_CHARACTERS,
  MIN_GENERATED_POST_CHARACTERS,
  normalizeGeneratedPostCopy,
  POST_GENERATION_SYSTEM_PROMPT,
} from "../_shared/groq.ts";
import type { ContentProfile } from "../_shared/types.ts";
import { assertEquals, assertRejects } from "./assert.ts";

const BUSINESS_CONTEXT = `
Лендинг — от 49 990 ₸.
Многостраничный сайт — от 89 990 ₸.
WhatsApp-бот или Telegram-бот — от 200 000 ₸.
`;

function profile(overrides: Partial<ContentProfile> = {}): ContentProfile {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    business_context: BUSINESS_CONTEXT,
    target_audience: "Предприниматели и компании с задачами по цифровизации.",
    tone_of_voice: "Экспертно, понятно и без агрессивных продаж.",
    publish_times_utc: [
      "01:00:00",
      "03:00:00",
      "05:00:00",
      "07:00:00",
      "09:00:00",
      "11:00:00",
      "13:00:00",
      "15:00:00",
      "17:00:00",
      "19:00:00",
      "21:00:00",
      "23:00:00",
    ],
    ...overrides,
  };
}

Deno.test("content schedule creates twelve configured daily slots", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T00:00:00.000Z"), 1);
  assertEquals(slots.map((slot) => slot.scheduledAt), [
    "2026-07-19T01:00:00.000Z",
    "2026-07-19T03:00:00.000Z",
    "2026-07-19T05:00:00.000Z",
    "2026-07-19T07:00:00.000Z",
    "2026-07-19T09:00:00.000Z",
    "2026-07-19T11:00:00.000Z",
    "2026-07-19T13:00:00.000Z",
    "2026-07-19T15:00:00.000Z",
    "2026-07-19T17:00:00.000Z",
    "2026-07-19T19:00:00.000Z",
    "2026-07-19T21:00:00.000Z",
    "2026-07-19T23:00:00.000Z",
  ]);
});

Deno.test("content schedule skips elapsed slots and continues on the next day", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T10:00:00.000Z"), 1);
  assertEquals(slots.map((slot) => slot.scheduledAt), [
    "2026-07-19T11:00:00.000Z",
    "2026-07-19T13:00:00.000Z",
    "2026-07-19T15:00:00.000Z",
    "2026-07-19T17:00:00.000Z",
    "2026-07-19T19:00:00.000Z",
    "2026-07-19T21:00:00.000Z",
    "2026-07-19T23:00:00.000Z",
    "2026-07-20T01:00:00.000Z",
    "2026-07-20T03:00:00.000Z",
    "2026-07-20T05:00:00.000Z",
    "2026-07-20T07:00:00.000Z",
    "2026-07-20T09:00:00.000Z",
  ]);
});

Deno.test("content angle is deterministic and rotates between generation keys", () => {
  const first = pickContentAngle("profile:2026-07-20:12");
  assertEquals(first, pickContentAngle("profile:2026-07-20:12"));
  assertEquals(first === pickContentAngle("profile:2026-07-21:12"), false);
});

Deno.test("scheduled content angles do not repeat before three full days", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T00:00:00.000Z"), 3).slice(
    0,
    36,
  );
  const angles = slots.map((slot) => pickContentAngle(slot.generationKey));
  assertEquals(new Set(angles).size, 36);
  assertEquals(angles.filter((angle) => /формат:\s*продающ/iu.test(angle)).length, 9);
  for (let index = 1; index < angles.length; index += 1) {
    const previousIsSelling = /формат:\s*продающ/iu.test(angles[index - 1]);
    const currentIsSelling = /формат:\s*продающ/iu.test(angles[index]);
    assertEquals(previousIsSelling && currentIsSelling, false);
  }
  assertEquals(
    /формат:\s*продающ/iu.test(angles.at(-1) ?? "") &&
      /формат:\s*продающ/iu.test(angles[0]),
    false,
  );
});

Deno.test("every curated fallback passes the post copy guard", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T00:00:00.000Z"), 3).slice(
    0,
    36,
  );
  for (const slot of slots) {
    const angle = pickContentAngle(slot.generationKey);
    const fallback = fallbackPostForAngle(angle);
    assertGeneratedPostCopy(fallback, BUSINESS_CONTEXT, angle);
    assertEquals(Array.from(fallback).length <= MAX_GENERATED_POST_CHARACTERS, true);
    assertEquals(Array.from(fallback).length >= MIN_GENERATED_POST_CHARACTERS, true);
  }
});

Deno.test("curated fallback avoids recently used copy", () => {
  const angle = pickContentAngle("profile:2026-07-19:1100");
  const first = fallbackPostForAngle(angle);
  const second = fallbackPostForAngle(angle, [first]);
  assertEquals(first === second, false);
});

Deno.test("similarity guard catches a shorter paraphrase of a recent post", () => {
  assertEquals(
    isGeneratedPostTooSimilar(
      "Где отвечают быстрее: в директ или WhatsApp?",
      [
        "Вы сами пишете бизнесу в директ или сразу ищете WhatsApp? Интересно, где обычно отвечают быстрее.",
      ],
    ),
    true,
  );
  assertEquals(
    isGeneratedPostTooSimilar(
      "Если менеджер весь день копирует один ответ, проблема уже не в скорости печати 🤔",
      ["Сайт красивый. Цена рядом, а запись снова спрятана."],
    ),
    false,
  );
});

Deno.test("shadow generation creates drafts and skips existing slots", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const generatedFor: string[] = [];
  const recentLimits: number[] = [];
  const currentProfile = profile();
  const firstSlot = planContentSlots(
    currentProfile,
    new Date("2026-07-19T00:00:00.000Z"),
  )[0];

  const result = await generateQueuedContent({
    database: {
      getFutureGeneratedKeys: () => Promise.resolve([firstSlot.generationKey]),
      getRecentContentTexts: (limit) => {
        recentLimits.push(limit ?? 0);
        return Promise.resolve(["Недавний пост"]);
      },
      insertGeneratedContent: (values) => {
        inserted.push(values);
        return Promise.resolve(true);
      },
    },
    generator: {
      generatePost: ({ scheduledAt }) => {
        generatedFor.push(scheduledAt);
        return Promise.resolve(`Новый полезный пост для ${scheduledAt}`);
      },
    },
    profile: currentProfile,
    shadowMode: true,
    batchSize: 2,
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  assertEquals(result, { inserted: 2, failed: 0 });
  assertEquals(inserted.length, 2);
  assertEquals(inserted[0].status, "draft");
  assertEquals(inserted[0].origin, "ai_generated");
  assertEquals(generatedFor.includes(firstSlot.scheduledAt), false);
  assertEquals(recentLimits, [25]);
});

Deno.test("generation uses a curated fallback when the model rejects a slot", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const currentProfile = profile({ publish_times_utc: ["11:00:00"] });

  const result = await generateQueuedContent({
    database: {
      getFutureGeneratedKeys: () => Promise.resolve([]),
      getRecentContentTexts: () => Promise.resolve([]),
      insertGeneratedContent: (values) => {
        inserted.push(values);
        return Promise.resolve(true);
      },
    },
    generator: {
      generatePost: () => Promise.reject(new Error("model rejected")),
    },
    profile: currentProfile,
    shadowMode: true,
    batchSize: 1,
    now: new Date("2026-07-19T00:00:00.000Z"),
  });

  assertEquals(result, { inserted: 1, failed: 0 });
  assertEquals(
    inserted[0].text,
    fallbackPostForAngle(
      pickContentAngle(String(inserted[0].generation_key)),
    ),
  );
});

Deno.test("copy guard accepts confirmed prices with the required qualifier", () => {
  assertGeneratedCopy(
    "Лендинг делаем от 49 990 ₸, многостраничный сайт — от 89 990 ₸, а бот — от 200 000 ₸.",
    BUSINESS_CONTEXT,
  );
});

Deno.test("copy guard accepts a confirmed non-price number without the price qualifier", () => {
  assertGeneratedCopy(
    "За неделю вручную разобрали 3 обращения и нашли повторяющийся вопрос.",
    `${BUSINESS_CONTEXT}\nЗа неделю вручную разобрали 3 обращения.`,
  );
});

Deno.test("copy guard accepts approved Latin brand names", () => {
  assertGeneratedCopy(
    "AI-автоматизация и WhatsApp-бот помогают разбирать обращения из Instagram.",
    BUSINESS_CONTEXT,
  );
});

Deno.test("copy guard rejects invented numbers", async () => {
  await assertRejects(
    () => assertGeneratedCopy("Поднимем заявки на 30%.", BUSINESS_CONTEXT),
    "unsupported number",
  );
});

Deno.test("copy guard rejects a confirmed price without the word от", async () => {
  await assertRejects(
    () => assertGeneratedCopy("Лендинг стоит 49 990 ₸.", BUSINESS_CONTEXT),
    "required 'от' qualifier",
  );
});

Deno.test("copy guard rejects a landing price attached to a generic solution", async () => {
  await assertRejects(
    () => assertGeneratedCopy("Подберём решение от 49 990 ₸ после обсуждения.", BUSINESS_CONTEXT),
    "without naming лендинг",
  );
});

Deno.test("copy guard rejects accidental Latin letters inside Russian copy", async () => {
  await assertRejects(
    () => assertGeneratedCopy("Сначала проверим, rõчно ли вам нужен сайт.", BUSINESS_CONTEXT),
    "unsupported Latin word",
  );
});

Deno.test("copy guard rejects banned AI wording", async () => {
  await assertRejects(
    () => assertGeneratedCopy("Сайт играет важную роль для бизнеса.", BUSINESS_CONTEXT),
    "banned wording",
  );
});

Deno.test("post copy guard accepts useful copy without a price", () => {
  assertGeneratedPostCopy(
    "Сайт красивый. Цена в соцсетях, адрес на картах, запись в WhatsApp. Клиент хотел записаться, а получил квест 🫠",
    BUSINESS_CONTEXT,
    "ФОРМАТ: наблюдение. Сайт превращает запись в квест",
  );
});

Deno.test("post normalizer preserves a human observation without adding a sale", () => {
  assertEquals(
    normalizeGeneratedPostCopy(
      "  Если контакты спрятаны глубоко, клиенту приходится искать способ связи. Вот и весь квест.  ",
      "ФОРМАТ: наблюдение. Контакты на сайте",
    ),
    "Если контакты спрятаны глубоко, клиенту приходится искать способ связи. Вот и весь квест.",
  );
});

Deno.test("post normalizer preserves a specific question without adding an offer", () => {
  assertEquals(
    normalizeGeneratedPostCopy(
      "Повторяющиеся вопросы занимают время менеджера. Какой вопрос клиенты задают чаще всего?",
      "ФОРМАТ: обсуждение. Повторяющиеся вопросы клиентов",
    ),
    "Повторяющиеся вопросы занимают время менеджера. Какой вопрос клиенты задают чаще всего?",
  );
});

Deno.test("post copy guard accepts a confirmed non-price number in a regular angle", () => {
  assertGeneratedPostCopy(
    "За неделю вручную разобрали 3 обращения и нашли повтор. Мы собираем такие вопросы в сценарий бота. Что у вас повторяется чаще всего?",
    `${BUSINESS_CONTEXT}\nЗа неделю вручную разобрали 3 обращения.`,
    "ФОРМАТ: продающий. Повторяющиеся вопросы клиентов до автоматизации",
  );
});

Deno.test("post copy guard rejects uncontrolled lead promises", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Сделаем лендинг, который принесёт вам заявки.",
        BUSINESS_CONTEXT,
        "что проверить бизнесу перед заказом лендинга",
      ),
    "uncontrolled business outcome",
  );
});

Deno.test("reply copy guard rejects a promise of leads without a manager", async () => {
  await assertRejects(
    () =>
      assertGeneratedReplyCopy(
        "Сделаем сайт, который будет приносить заявки без участия менеджера.",
        BUSINESS_CONTEXT,
      ),
    "promises leads",
  );
});

Deno.test("post copy guard rejects prices outside a price-focused angle", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Перед запуском проверьте структуру лендинга. Разработка — от 49 990 ₸.",
        BUSINESS_CONTEXT,
        "что проверить бизнесу перед заказом лендинга",
      ),
    "outside a price-focused content angle",
  );
});

Deno.test("post copy guard accepts prices in a price-focused angle", () => {
  assertGeneratedPostCopy(
    "Лендинг начинается от 49 990 ₸. Мы собираем страницу под одно предложение и действие. Что вы хотите продавать через лендинг?",
    BUSINESS_CONTEXT,
    "ФОРМАТ: продающий. Ответ на сомнение о цене лендинга",
  );
});

Deno.test("post copy guard rejects generic sales wording", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Если вашему бизнесу нужен сайт, мы можем помочь с разработкой.",
        BUSINESS_CONTEXT,
        "как сайт поддерживает цифровой статус компании",
      ),
    "generic sales wording",
  );
});

Deno.test("post copy guard rejects lead-acquisition claims", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Добавьте на сайт форму, чтобы привлечь заявки из поиска.",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "will attract leads or clients",
  );
});

Deno.test("post copy guard rejects client-acquisition claims", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Добавьте форму записи для привлечения клиентов.",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "will attract leads or clients",
  );
});

Deno.test("post copy guard rejects split spelling of насколько", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "На сколько глубоко спрятана форма записи на вашем сайте?",
        BUSINESS_CONTEXT,
        "контакты и запись спрятаны слишком глубоко",
      ),
    "split spelling",
  );
});

Deno.test("post copy guard rejects ambiguous bot-hours wording", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Обсудите, кто отвечает на обращения после часа работы бота.",
        BUSINESS_CONTEXT,
        "процессы и ограничения до запуска бизнес-бота",
      ),
    "ambiguous bot-hours phrase",
  );
});

Deno.test("post copy guard rejects ищите in a question about search", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Что обычно ищите на сайте компании: цену или примеры работ?",
        BUSINESS_CONTEXT,
        "ФОРМАТ: обсуждение. Цена или примеры работ на сайте",
      ),
    "ищите",
  );
});

Deno.test("post generator prompt requires varied human copy", () => {
  for (
    const requirement of [
      "от 35 до 320 символов",
      "одна сильная фраза",
      "маленькая сцена",
      "как человек из современного интернета",
      "одну основную мысль",
      "не копирайтер",
      "Не повторяй формат",
    ]
  ) {
    assertEquals(POST_GENERATION_SYSTEM_PROMPT.includes(requirement), true);
  }
});

Deno.test("post generator prompt varies questions and forbids unsupported promises", () => {
  for (
    const requirement of [
      "Не заканчивай каждый пост вопросом",
      "он должен быть один, конкретный",
      "Не используй «Что думаете?»",
      "Не обещай позиции или топ в Google",
      "Не гарантируй сроки",
      "юридических и финансовых гарантий",
      "отдельная статья расходов",
    ]
  ) {
    assertEquals(POST_GENERATION_SYSTEM_PROMPT.includes(requirement), true);
  }
});

Deno.test("post generator prompt sells only in selling angles", () => {
  for (
    const requirement of [
      "не добавляй фразу о том, что делает Mononyx",
      "Если формат продающий",
      "Не продавай в каждом посте",
      "Могу показать демо",
      "Можем разобрать ваш случай",
    ]
  ) {
    assertEquals(POST_GENERATION_SYSTEM_PROMPT.includes(requirement), true);
  }
});

Deno.test("post copy guard accepts a relevant observation without a question", () => {
  assertGeneratedPostCopy(
    "На сайте услуга понятна сразу. А кнопку записи всё равно приходится искать по всей странице 🫠",
    BUSINESS_CONTEXT,
    "ФОРМАТ: наблюдение. Кнопка записи на сайте",
  );
});

Deno.test("post copy guard accepts an adjacent business topic without naming a service", () => {
  assertGeneratedPostCopy(
    "Бизнес ответил клиенту утром. Формально ответил. Только клиент уже написал другому 😅",
    BUSINESS_CONTEXT,
    "ФОРМАТ: наблюдение. Скорость ответа клиенту",
  );
});

Deno.test("post copy guard rejects a generic engagement question", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Мы делаем сайт понятным с первого экрана для ваших клиентов. Что думаете?",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "generic engagement question",
  );
});

Deno.test("post copy guard rejects more than one question", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Ваш сайт сразу объясняет услугу? Мы упрощаем его структуру. Что сейчас мешает вашему сайту?",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "more than one question",
  );
});

Deno.test("post copy guard rejects an agency offer in a non-selling angle", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "На сайте услуга должна быть понятна сразу. Мы упрощаем первый экран и кнопку записи.",
        BUSINESS_CONTEXT,
        "ФОРМАТ: наблюдение. Первый экран сайта",
      ),
    "Non-selling post contains an agency offer",
  );
});

Deno.test("post copy guard requires an agency offer in a selling angle", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "На сайте услуга должна быть понятна сразу. Если актуально, напишите.",
        BUSINESS_CONTEXT,
        "ФОРМАТ: продающий. Первый экран сайта",
      ),
    "Selling post does not state what the agency does",
  );
});

Deno.test("post copy guard allows zero to two reaction emoji", () => {
  assertGeneratedPostCopy(
    "Сайт красивый. Запись спрятана, цена в соцсетях. Клиент получил квест 🫠😅",
    BUSINESS_CONTEXT,
    "ФОРМАТ: наблюдение. Сайт превращает запись в квест",
  );
});

Deno.test("post copy guard rejects more than two emoji", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Сайт красивый. Запись спрятана, цена в соцсетях. Клиент получил квест 🫠😅🤔",
        BUSINESS_CONTEXT,
        "ФОРМАТ: наблюдение. Сайт превращает запись в квест",
      ),
    "more than two emoji",
  );
});

Deno.test("post copy guard rejects advertising emoji", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Сайт красивый. Запись понятна, цена рядом. Клиенту удобно 🚀",
        BUSINESS_CONTEXT,
        "ФОРМАТ: наблюдение. Сайт и запись",
      ),
    "advertising emoji",
  );
});

Deno.test("post copy guard rejects a long dash", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Сайт красивый — запись спрятана. Клиент снова ищет кнопку.",
        BUSINESS_CONTEXT,
        "ФОРМАТ: наблюдение. Сайт и запись",
      ),
    "long dash",
  );
});

Deno.test("post copy guard rejects off-platform CTA", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Форма записи спрятана внизу страницы. Напишите мне в WhatsApp?",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "off-platform or subscription CTA",
  );
});

Deno.test("post copy guard rejects promised Google ranking", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Мы выведем ваш сайт в топ Google. Что мешает вам начать?",
        BUSINESS_CONTEXT,
        "как сайт поддерживает цифровой статус компании",
      ),
    "search ranking",
  );
});

Deno.test("post copy guard rejects guaranteed delivery timeline", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Гарантируем срок разработки. Какой проект вы планируете?",
        BUSINESS_CONTEXT,
        "подготовка к заказу сайта",
      ),
    "delivery timeline",
  );
});

Deno.test("post copy guard rejects legal or financial guarantees", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Даём финансовую гарантию окупаемости. Хотите обсудить проект?",
        BUSINESS_CONTEXT,
        "что проверить до заказа автоматизации",
      ),
    "legal or financial guarantee",
  );
});

Deno.test("post copy guard rejects guaranteed ROI", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "Гарантируем ROI после запуска сайта. Что хотите улучшить?",
        BUSINESS_CONTEXT,
        "что проверить до заказа сайта",
      ),
    "guarantees an uncontrolled business outcome",
  );
});
