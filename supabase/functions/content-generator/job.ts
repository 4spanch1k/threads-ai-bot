import {
  envBoolean,
  envInteger,
  optionalEnv,
  requiredEnv,
  supabaseAdminKey,
} from "../_shared/env.ts";
import { GroqClient } from "../_shared/groq.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import type { ContentProfile, JobResult } from "../_shared/types.ts";

const CONTENT_ANGLES = [
  "аудит первого экрана сайта: сразу ли понятны услуга, город и способ связи",
  "что подготовить перед заказом лендинга: цель страницы, одно главное действие и материалы",
  "что теряется, когда вся информация о компании находится только в социальных сетях",
  "как начать разработку сайта без технического задания: собрать услуги, частые вопросы и примеры",
  "какие вопросы задать подрядчику о составе работ, этапах и поддержке проекта",
  "когда нужен лендинг для одного предложения, а когда многостраничный сайт для нескольких услуг",
  "какие повторяющиеся обращения стоит передать WhatsApp- или Telegram-боту",
  "как проходит работа над проектом: обсуждение задачи, согласование плана, затем разработка",
  "ошибка в структуре сайта компании сферы услуг: контакты и запись спрятаны слишком глубоко",
  "какие сведения на сайте помогают проверить компанию перед обращением",
  "когда мобильное приложение оправдано повторяющимся пользовательским сценарием",
  "какие процессы и ограничения обсудить до запуска бизнес-бота",
  "из чего складывается стоимость цифрового продукта без обещаний фиксированной цены",
  "что клиент проверяет на сайте компании перед первым обращением",
  "короткий вопрос предпринимателю о самой повторяющейся цифровой задаче в его работе",
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
  const hash = Array.from(generationKey).reduce(
    (value, character) => (value * 31 + character.codePointAt(0)!) >>> 0,
    0,
  );
  return CONTENT_ANGLES[hash % CONTENT_ANGLES.length];
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
      const text = await options.generator.generatePost({
        businessContext: options.profile.business_context,
        targetAudience: options.profile.target_audience,
        toneOfVoice: options.profile.tone_of_voice,
        contentAngle: pickContentAngle(slot.generationKey),
        scheduledAt: slot.scheduledAt,
        recentPosts,
      });
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
