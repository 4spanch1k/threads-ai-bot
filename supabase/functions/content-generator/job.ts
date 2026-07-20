import {
  envBoolean,
  envInteger,
  optionalEnv,
  requiredEnv,
  supabaseAdminKey,
} from "../_shared/env.ts";
import { assertGeneratedPostCopy, GroqClient, isGeneratedPostTooSimilar } from "../_shared/groq.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import type { ContentProfile, JobResult } from "../_shared/types.ts";

const CONTENT_BRIEFS = [
  {
    angle:
      "ФОРМАТ: наблюдение. Красивый сайт превращает запись в квест: цена в соцсетях, адрес на картах, запись в WhatsApp. Без продажи и без вопроса",
    fallback:
      "Сайт красивый. Цена в соцсетях, адрес на картах, запись в WhatsApp. Клиент хотел записаться, а получил квест 🫠",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Бизнес отвечает клиенту через несколько часов и считает, что всё нормально. Показать, что человек уже мог уйти, закончить точным вопросом",
    fallback:
      "Бизнес ответил клиенту через несколько часов. Формально ответил. Только клиент уже написал другому 😅 Вы бы стали ждать?",
  },
  {
    angle:
      "ФОРМАТ: мнение. Если цену нужно искать по актуальным в соцсетях, сайт уже не помогает. Коротко и немного спорно, без вопроса и продажи",
    fallback:
      "Если цену нужно искать по актуальным в соцсетях, сайт уже не помогает. Он просто существует.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, что сильнее раздражает: медленный сайт или обязательная регистрация ради одного вопроса. Без продажи",
    fallback:
      "Что сильнее бесит: медленный сайт или форма, которая просит зарегистрироваться ради одного вопроса?",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Бот на любой вопрос просит оставить номер и превращается в форму с лишним шагом. Лёгкая ирония, без продажи и вопроса",
    fallback:
      "Бот на любой вопрос отвечает: «Оставьте номер». Получилась обычная форма, только с лишним шагом 🫠",
  },
  {
    angle:
      "ФОРМАТ: продающий. Клиенты ежедневно повторяют один вопрос. Спокойно предложить бота, который отвечает и передаёт сложное человеку. Один мягкий призыв",
    fallback:
      "Клиенты каждый день задают один вопрос. Мы настраиваем бота, который отвечает и передаёт сложное человеку. Если актуально, напишите.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. На главной сайта слишком много главных кнопок, поэтому посетитель выбирает закрыть страницу. Короткая шутка, без вопроса и продажи",
    fallback:
      "На главной куча кнопок. Каждая «главная». Клиент смотрит пару секунд и выбирает ещё одну: закрыть сайт.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Бизнес просит сайт как у конкурента, а потом удивляется сходству. Немного спорно и разговорно, без вопроса и продажи",
    fallback:
      "Бизнес просит сделать сайт «как у конкурента». Потом удивляется, почему результат похож на конкурента. Ну такое.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, что человек первым ищет на сайте: цену или примеры работ. Добавить наблюдение, что бизнес часто прячет оба",
    fallback:
      "Вы сами сначала ищете на сайте цену или примеры работ? Почему-то бизнесы часто прячут и то и другое.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Мобильное приложение без понятного повторяющегося действия быстро становится лишней иконкой. Без вопроса и продажи",
    fallback:
      "Мобильное приложение без действия, ради которого хочется его открыть, быстро становится ещё одной иконкой на телефоне.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, где человек предпочитает писать бизнесу: в директ или WhatsApp. Без продажи",
    fallback:
      "Вы сами пишете бизнесу в директ или сразу ищете WhatsApp? Интересно, где обычно отвечают быстрее.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Цена лендинга и понятный случай для одной услуги и одного действия. Указать только подтверждённую стартовую цену и один спокойный призыв",
    fallback:
      "Лендинг от 49 990 ₸ подходит, когда нужно показать одну услугу и привести к одному действию. Мы собираем такие страницы под ключ. Если актуально, напишите.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Предприниматель откладывает сайт из-за отсутствия идеального ТЗ, хотя для первого разговора хватает услуг и пары примеров. Без продажи",
    fallback:
      "Предприниматель откладывает сайт, потому что нет идеального ТЗ. Хотя для первого разговора часто хватает списка услуг и пары примеров.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Если менеджер весь день копирует один ответ, проблема уже не в скорости печати. Очень коротко, можно один реакционный эмодзи, без продажи",
    fallback: "Если менеджер весь день копирует один ответ, проблема уже не в скорости печати 🤔",
  },
  {
    angle:
      "ФОРМАТ: продающий. Сайт должен сразу показать услугу и способ записаться. Сказать, что агентство начинает разработку именно с этого, без пафоса и гарантий",
    fallback:
      "Сайт должен быстро показать услугу и способ записаться. Мы с этого и начинаем. Цвет кнопок будет потом. Можем разобрать ваш случай.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Мобильное приложение уместно, когда клиент часто возвращается к записи или заказу. Коротко сказать, что агентство проектирует такой путь, и предложить демо",
    fallback:
      "Если клиент часто возвращается к записи или заказу, приложение может быть удобнее сайта. Мы проектируем такой путь. Могу показать демо.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. На сайте кнопка записи выглядит нормально, но ничего не делает. Короткий сухой поворот, без вопроса и продажи",
    fallback: "На сайте нажимаешь «Записаться», а кнопка ничего не делает. Красиво. Бесполезно.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, что раздражает сильнее: цена по запросу или обязательный номер телефона, чтобы узнать цену. Без продажи",
    fallback:
      "Что раздражает сильнее: «цена по запросу» или просьба оставить номер, чтобы узнать цену?",
  },
  {
    angle:
      "ФОРМАТ: мнение. Сайт без примеров работ просит поверить бизнесу на слово. Одна короткая спорная мысль, без вопроса и продажи",
    fallback: "Сайт без примеров работ просит поверить бизнесу на слово. Смело.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Кнопка WhatsApp открывает пустой чат без подсказки, и клиент должен сам сформулировать всё заново. Лёгкая ирония, без продажи",
    fallback:
      "Кнопка WhatsApp есть. Открывает пустой чат без подсказки. Дальше клиент сам догадается, что написать 🙂",
  },
  {
    angle:
      "ФОРМАТ: продающий. На первом экране сайта непонятно, куда нажать. Сказать, что агентство разбирает экран и убирает лишние шаги. Один мягкий призыв",
    fallback:
      "На первом экране непонятно, куда нажать? Мы разбираем сайт и убираем лишние шаги. Можем посмотреть ваш случай.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Бот несколько раз пишет, что понял клиента, а потом снова задаёт тот же вопрос. Иронично, без вопроса и продажи",
    fallback:
      "Бот несколько раз пишет: «Я вас понял». Потом снова спрашивает то же самое. Очень убедительно 🫠",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, стал бы человек устанавливать мобильное приложение ради одной записи или выбрал бы сайт. Без продажи",
    fallback: "Вы бы устанавливали мобильное приложение ради одной записи или выбрали сайт?",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Менеджер отправляет цены голосовым сообщением, а клиенту приходится переслушивать. Короткая знакомая сцена, без продажи",
    fallback:
      "Менеджер отправляет цены голосовым сообщением. Клиент хотел сравнить, а получил домашнее задание.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Лендинг, на который сложили все услуги, превращается в сжатый каталог. Коротко, без вопроса и продажи",
    fallback:
      "Лендинг, на который сложили все услуги, быстро превращается в сжатый каталог. Вроде коротко, а читать тяжело.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Клиент часто возвращается проверить запись или заказ. Сказать, что агентство проектирует для этого приложение, и предложить демо",
    fallback:
      "Клиент часто возвращается проверить запись или заказ? Мы проектируем для этого мобильные приложения. Могу показать демо.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Простая форма на сайте просит должность и компанию, будто клиент устраивается на работу. Иронично, без продажи",
    fallback:
      "Форма на сайте просит должность и компанию перед обычным вопросом. Такое чувство, будто клиент устраивается на работу.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, что вызывает больше доверия: аккуратный сайт или активный Instagram без сайта. Без продажи",
    fallback: "Что вызывает больше доверия: аккуратный сайт или активный Instagram без сайта?",
  },
  {
    angle:
      "ФОРМАТ: мнение. Бот притворяется человеком и теряет доверие при первой странной фразе. Немного спорно, без вопроса и продажи",
    fallback:
      "Бот, который притворяется человеком, теряет доверие при первой странной фразе. Честная подпись была бы проще.",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. Кнопка Подробнее на сайте ведёт на ту же страницу. Короткий сухой юмор, без вопроса и продажи",
    fallback: "Кнопка «Подробнее» на сайте ведёт на ту же страницу. Подробнее не стало.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Старый сайт приходится объяснять клиенту голосом. Сказать, что агентство пересобирает структуру и первый экран. Один мягкий призыв",
    fallback:
      "Если сайт приходится объяснять клиенту голосом, он уже мешает. Мы пересобираем структуру и первый экран. Можем посмотреть ваш случай.",
  },
  {
    angle:
      "ФОРМАТ: обсуждение. Спросить, что настораживает сильнее: цена от или подрядчик, который называет точную сумму до вопросов. Без продажи",
    fallback:
      "Что настораживает сильнее: цена «от» или подрядчик, который называет точную сумму до вопросов?",
  },
  {
    angle:
      "ФОРМАТ: наблюдение. На мобильном сайте меню закрывает половину экрана и отвлекает от услуги. Лёгкая ирония, без продажи",
    fallback:
      "На мобильном сайте меню закрывает половину экрана. Видимо, чтобы клиент точно не отвлёкся на услугу.",
  },
  {
    angle:
      "ФОРМАТ: мнение. Автоматизация полезна для повторяющихся действий, а в каждый раз новом процессе бот добавит путаницы. Без вопроса и продажи",
    fallback:
      "Автоматизация полезна там, где действие повторяется. Если процесс каждый раз новый, бот только добавит путаницы.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Менеджер повторяет ответы и вручную передаёт сложные обращения. Сказать, что агентство настраивает бота и передачу человеку. Один призыв",
    fallback:
      "Менеджер повторяет ответы и вручную передаёт сложные обращения? Мы настраиваем бота и передачу человеку. Если актуально, напишите.",
  },
  {
    angle:
      "ФОРМАТ: продающий. Подтверждённая стартовая цена многостраничного сайта для нескольких услуг. Коротко объяснить, что агентство собирает структуру, и дать один призыв",
    fallback:
      "Многостраничный сайт от 89 990 ₸ подходит, когда услуг несколько. Мы собираем структуру и нужные страницы. Если актуально, напишите.",
  },
];

// Keep the nine selling angles separated by three conversational posts.
const CONTENT_ROTATION = [
  0,
  1,
  2,
  5,
  3,
  4,
  6,
  11,
  7,
  8,
  9,
  14,
  10,
  12,
  13,
  15,
  16,
  17,
  18,
  20,
  19,
  21,
  22,
  25,
  23,
  24,
  26,
  30,
  27,
  28,
  29,
  34,
  31,
  32,
  33,
  35,
];

export interface ContentSlot {
  generationKey: string;
  scheduledAt: string;
}

interface ContentGeneratorDatabase {
  getFutureGeneratedKeys(from: string, until: string): Promise<string[]>;
  getRecentContentTexts(limit?: number): Promise<string[]>;
  insertGeneratedContent(values: Record<string, unknown>): Promise<boolean>;
}

interface PostGenerator {
  generatePost(request: {
    businessContext: string;
    targetAudience: string;
    toneOfVoice: string;
    contentAngle: string;
    scheduledAt: string;
    recentPosts: string[];
  }): Promise<string>;
}

export function pickContentAngle(generationKey: string): string {
  const slot = /:(\d{4})-(\d{2})-(\d{2}):(\d{2})(\d{2})$/.exec(generationKey);
  if (slot) {
    const day = Math.floor(
      Date.UTC(Number(slot[1]), Number(slot[2]) - 1, Number(slot[3])) / 86_400_000,
    );
    const minutes = Number(slot[4]) * 60 + Number(slot[5]);
    const slotIndex = Math.floor(minutes / 120);
    const rotationIndex = (day * 12 + slotIndex) % CONTENT_ROTATION.length;
    return CONTENT_BRIEFS[CONTENT_ROTATION[rotationIndex]].angle;
  }

  const hash = Array.from(generationKey).reduce((value, character) => {
    const mixed = value ^ character.codePointAt(0)!;
    return Math.imul(mixed, 16_777_619) >>> 0;
  }, 2_166_136_261);
  return CONTENT_BRIEFS[CONTENT_ROTATION[hash % CONTENT_ROTATION.length]].angle;
}

export function fallbackPostForAngle(contentAngle: string, recentPosts: string[] = []): string {
  const preferred = CONTENT_BRIEFS.findIndex((brief) => brief.angle === contentAngle);
  const start = preferred >= 0 ? preferred : 0;
  const selling = /формат:\s*продающ/iu.test(CONTENT_BRIEFS[start].angle);

  for (let offset = 0; offset < CONTENT_BRIEFS.length; offset += 1) {
    const brief = CONTENT_BRIEFS[(start + offset) % CONTENT_BRIEFS.length];
    if (/формат:\s*продающ/iu.test(brief.angle) !== selling) continue;
    if (!isGeneratedPostTooSimilar(brief.fallback, recentPosts)) return brief.fallback;
  }
  return CONTENT_BRIEFS[start].fallback;
}

function parseUtcTime(value: string): { hour: number; minute: number; key: string } {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) throw new Error(`Invalid publish time: ${value}`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid publish time: ${value}`);
  return { hour, minute, key: `${match[1]}${match[2]}` };
}

export function planContentSlots(
  profile: ContentProfile,
  now: Date,
  horizonDays = 14,
): ContentSlot[] {
  const end = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  const cursor = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const slots: ContentSlot[] = [];

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    for (const configuredTime of profile.publish_times_utc) {
      const time = parseUtcTime(configuredTime);
      const scheduledAt = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        time.hour,
        time.minute,
      ));
      if (scheduledAt > now && scheduledAt <= end) {
        slots.push({
          generationKey: `${profile.id}:${date}:${time.key}`,
          scheduledAt: scheduledAt.toISOString(),
        });
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return slots.sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown content generation error";
}

export async function generateQueuedContent(options: {
  database: ContentGeneratorDatabase;
  generator: PostGenerator;
  profile: ContentProfile;
  shadowMode: boolean;
  batchSize: number;
  now?: Date;
}): Promise<JobResult> {
  const now = options.now ?? new Date();
  const horizonEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const existing = new Set(
    await options.database.getFutureGeneratedKeys(now.toISOString(), horizonEnd.toISOString()),
  );
  const slots = planContentSlots(options.profile, now)
    .filter((slot) => !existing.has(slot.generationKey))
    .slice(0, options.batchSize);
  const recentPosts = await options.database.getRecentContentTexts(25);
  let inserted = 0;
  let failed = 0;

  for (const slot of slots) {
    try {
      const contentAngle = pickContentAngle(slot.generationKey);
      let text: string;
      try {
        text = await options.generator.generatePost({
          businessContext: options.profile.business_context,
          targetAudience: options.profile.target_audience,
          toneOfVoice: options.profile.tone_of_voice,
          contentAngle,
          scheduledAt: slot.scheduledAt,
          recentPosts,
        });
      } catch (error) {
        text = fallbackPostForAngle(contentAngle, recentPosts);
        assertGeneratedPostCopy(text, options.profile.business_context, contentAngle);
        console.warn(JSON.stringify({
          event: "content_generation_fallback",
          generation_key: slot.generationKey,
          message: message(error),
        }));
      }
      const created = await options.database.insertGeneratedContent({
        text,
        status: options.shadowMode ? "draft" : "scheduled",
        scheduled_at: slot.scheduledAt,
        origin: "ai_generated",
        generation_key: slot.generationKey,
      });
      if (created) {
        inserted += 1;
        recentPosts.unshift(text);
      }
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        event: "content_generation_failed",
        generation_key: slot.generationKey,
        message: message(error),
      }));
    }
  }

  return { inserted, failed };
}

export async function runContentGenerator(): Promise<JobResult> {
  const database = new SupabaseRestClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey());
  const profile = await database.getActiveContentProfile();
  if (!profile) return { inserted: 0, skipped: true, failed: 0 };

  const generator = new GroqClient(
    requiredEnv("GROQ_API_KEY"),
    optionalEnv("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
  );
  return generateQueuedContent({
    database,
    generator,
    profile,
    shadowMode: envBoolean("SHADOW_MODE", true),
    batchSize: envInteger("CONTENT_GENERATION_BATCH_SIZE", 7, 10),
  });
}
