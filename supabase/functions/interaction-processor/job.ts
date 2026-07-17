import { Classifier } from "../_shared/classifier.ts";
import {
  envBoolean,
  envInteger,
  optionalEnv,
  requiredEnv,
  supabaseAdminKey,
} from "../_shared/env.ts";
import { GroqClient } from "../_shared/groq.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import { TelegramClient } from "../_shared/telegram.ts";
import { ThreadsClient } from "../_shared/threads.ts";
import type { Classification, InteractionRow, JobResult } from "../_shared/types.ts";

interface InteractionDatabase {
  updateInteraction(id: string, values: Record<string, unknown>): Promise<void>;
}

interface ReplyClient {
  reply(replyToId: string, text: string): Promise<string>;
}

interface NotificationClient {
  send(text: string): Promise<void>;
}

interface ClassifierClient {
  classify(text: string): Promise<Classification>;
}

function existingClassification(interaction: InteractionRow): Classification | null {
  if (!interaction.intent || !interaction.confidence_level) return null;
  return {
    intent: interaction.intent,
    signals: interaction.signals,
    riskFlags: interaction.risk_flags,
    confidenceLevel: interaction.confidence_level,
    botReplyText: interaction.bot_reply_text,
  };
}

export function shouldReply(interaction: InteractionRow, classification: Classification): boolean {
  if (
    interaction.source !== "own_reply" ||
    classification.riskFlags.length > 0 ||
    classification.intent === "spam"
  ) return false;
  return classification.intent === "lead" &&
    (classification.confidenceLevel === "medium" || classification.confidenceLevel === "high");
}

export function shouldNotify(classification: Classification): boolean {
  if (classification.riskFlags.length > 0) return true;
  return classification.intent === "lead" &&
    (classification.confidenceLevel === "medium" || classification.confidenceLevel === "high");
}

function alertText(interaction: InteractionRow, classification: Classification): string {
  const username = interaction.username ? `@${interaction.username}` : "неизвестный пользователь";
  const risks = classification.riskFlags.length > 0 ? classification.riskFlags.join(", ") : "нет";
  return [
    "Threads Lead Bot",
    `Источник: ${interaction.source}`,
    `Пользователь: ${username}`,
    `Класс: ${classification.intent} / ${classification.confidenceLevel}`,
    `Риски: ${risks}`,
    `Текст: ${interaction.comment_text}`,
  ].join("\n");
}

export async function processInteraction(
  interaction: InteractionRow,
  options: {
    classifier: ClassifierClient;
    database: InteractionDatabase;
    shadowMode: boolean;
    threads: ReplyClient | null;
    telegram: NotificationClient | null;
    now?: () => string;
  },
): Promise<void> {
  const now = options.now ?? (() => new Date().toISOString());
  const classification = existingClassification(interaction) ??
    await options.classifier.classify(interaction.comment_text);
  const classificationValues = {
    intent: classification.intent,
    signals: classification.signals,
    risk_flags: classification.riskFlags,
    confidence_level: classification.confidenceLevel,
    bot_reply_text: classification.botReplyText,
    is_lead: classification.intent === "lead",
    last_error: null,
  };

  if (options.shadowMode) {
    await options.database.updateInteraction(interaction.id, {
      ...classificationValues,
      status: "classified",
      processing_started_at: null,
      next_retry_at: null,
      processed_at: now(),
    });
    return;
  }

  if (!options.threads || !options.telegram) {
    throw new Error("Action clients are required outside shadow mode");
  }

  // Keep the row leased until every required side effect is persisted.
  await options.database.updateInteraction(interaction.id, classificationValues);

  if (shouldReply(interaction, classification) && !interaction.reply_sent) {
    if (!classification.botReplyText) throw new Error("Required reply text is empty");
    const separator = interaction.source_item_id.indexOf(":");
    const replyId = separator >= 0
      ? interaction.source_item_id.slice(separator + 1)
      : interaction.source_item_id;
    await options.threads.reply(replyId, classification.botReplyText);
    await options.database.updateInteraction(interaction.id, { reply_sent: true });
  }

  if (shouldNotify(classification) && !interaction.notification_sent) {
    await options.telegram.send(alertText(interaction, classification));
    await options.database.updateInteraction(interaction.id, { notification_sent: true });
  }

  await options.database.updateInteraction(interaction.id, {
    status: "actioned",
    processing_started_at: null,
    next_retry_at: null,
    processed_at: now(),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown processing error";
}

export async function runInteractionProcessor(): Promise<JobResult> {
  const shadowMode = envBoolean("SHADOW_MODE", true);
  const batchSize = envInteger("INTERACTION_BATCH_SIZE", 5, 25);
  const maxAttempts = envInteger("MAX_ATTEMPTS", 5, 20);
  const database = new SupabaseRestClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey());
  const whatsappLink = optionalEnv("WHATSAPP_CONTACT_LINK") ?? "";
  if (!shadowMode && !whatsappLink) requiredEnv("WHATSAPP_CONTACT_LINK");
  const contentProfile = await database.getActiveContentProfile();
  const businessContext = contentProfile
    ? [
      contentProfile.business_context,
      `Целевая аудитория: ${contentProfile.target_audience}`,
      `Тон общения: ${contentProfile.tone_of_voice}`,
    ].join("\n\n")
    : "";
  const classifier = new Classifier(
    new GroqClient(
      requiredEnv("GROQ_API_KEY"),
      optionalEnv("GROQ_MODEL") ?? "llama-3.3-70b-versatile",
    ),
    whatsappLink,
    businessContext,
  );
  const threads = shadowMode
    ? null
    : new ThreadsClient(requiredEnv("THREADS_ACCESS_TOKEN"), requiredEnv("THREADS_USER_ID"));
  const telegram = shadowMode
    ? null
    : new TelegramClient(requiredEnv("TELEGRAM_BOT_TOKEN"), requiredEnv("TELEGRAM_CHAT_ID"));

  const interactions = await database.claimInteractions(batchSize, maxAttempts);
  let processed = 0;
  let failed = 0;
  for (const interaction of interactions) {
    try {
      await processInteraction(interaction, {
        classifier,
        database,
        shadowMode,
        threads,
        telegram,
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        event: "interaction_failed",
        interaction_id: interaction.id,
        message: message(error),
      }));
      await database.markInteractionFailed(interaction.id, message(error), maxAttempts);
    }
  }

  return { claimed: interactions.length, processed, failed };
}
