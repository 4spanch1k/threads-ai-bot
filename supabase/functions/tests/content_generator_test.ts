import {
  generateQueuedContent,
  pickContentAngle,
  planContentSlots,
} from "../content-generator/job.ts";
import {
  assertGeneratedCopy,
  assertGeneratedPostCopy,
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
    publish_times_utc: ["04:00:00", "06:30:00", "09:30:00", "12:00:00", "15:00:00"],
    ...overrides,
  };
}

Deno.test("content schedule creates five configured daily slots", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T00:00:00.000Z"), 1);
  assertEquals(slots.map((slot) => slot.scheduledAt), [
    "2026-07-19T04:00:00.000Z",
    "2026-07-19T06:30:00.000Z",
    "2026-07-19T09:30:00.000Z",
    "2026-07-19T12:00:00.000Z",
    "2026-07-19T15:00:00.000Z",
  ]);
});

Deno.test("content schedule skips elapsed slots and continues on the next day", () => {
  const slots = planContentSlots(profile(), new Date("2026-07-19T10:00:00.000Z"), 1);
  assertEquals(slots.map((slot) => slot.scheduledAt), [
    "2026-07-19T12:00:00.000Z",
    "2026-07-19T15:00:00.000Z",
    "2026-07-20T04:00:00.000Z",
    "2026-07-20T06:30:00.000Z",
    "2026-07-20T09:30:00.000Z",
  ]);
});

Deno.test("content angle is deterministic and rotates between generation keys", () => {
  const first = pickContentAngle("profile:2026-07-20:12");
  assertEquals(first, pickContentAngle("profile:2026-07-20:12"));
  assertEquals(first === pickContentAngle("profile:2026-07-21:12"), false);
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
    "Если на первом экране непонятно, чем занимается компания, посетителю приходится угадывать. Ваш заголовок отвечает на этот вопрос сразу?",
    BUSINESS_CONTEXT,
    "признаки сайта, который не вызывает доверия у клиента",
  );
});

Deno.test("post copy guard accepts a confirmed non-price number in a regular angle", () => {
  assertGeneratedPostCopy(
    "За неделю вручную разобрали 3 обращения и нашли повторяющийся вопрос. Какой вопрос чаще всего задают вам?",
    `${BUSINESS_CONTEXT}\nЗа неделю вручную разобрали 3 обращения.`,
    "повторяющиеся вопросы клиентов до автоматизации",
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
    "Лендинг начинается от 49 990 ₸, а многостраничный сайт — от 89 990 ₸. Какая структура нужна вашему бизнесу?",
    BUSINESS_CONTEXT,
    "ответ на сомнение о стоимости цифрового продукта",
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

Deno.test("post generator prompt requires varied hooks and a human voice", () => {
  for (
    const requirement of [
      "Первая фраза — хук",
      "не повторяй тип хука самого свежего поста",
      "реальная личная история",
      "прямой вопрос аудитории",
      "подтверждённое конкретное число",
      "Пиши голосом живого человека",
      "Не пиши «Mononyx предлагает»",
    ]
  ) {
    assertEquals(POST_GENERATION_SYSTEM_PROMPT.includes(requirement), true);
  }
});

Deno.test("post generator prompt requires one comment CTA and forbids unsupported promises", () => {
  for (
    const requirement of [
      "ровно один явный CTA",
      "ответить в комментариях",
      "Хук не должен быть кликбейтом",
      "Не обещай позиции или топ в Google",
      "Не гарантируй сроки",
      "юридических и финансовых гарантий",
      "отдельная статья расходов",
    ]
  ) {
    assertEquals(POST_GENERATION_SYSTEM_PROMPT.includes(requirement), true);
  }
});

Deno.test("post copy guard requires a final comment question", async () => {
  await assertRejects(
    () =>
      assertGeneratedPostCopy(
        "На первом экране сразу покажите услугу и способ связаться.",
        BUSINESS_CONTEXT,
        "аудит первого экрана сайта",
      ),
    "comment-oriented question",
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
