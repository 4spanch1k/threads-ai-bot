import { envBoolean, envInteger, requiredEnv, supabaseAdminKey } from "../_shared/env.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import { ThreadsClient } from "../_shared/threads.ts";
import type { JobResult } from "../_shared/types.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown publishing error";
}

export async function runContentPoster(): Promise<JobResult> {
  if (envBoolean("SHADOW_MODE", true)) {
    return { claimed: 0, published: 0, skipped: true, failed: 0 };
  }

  const batchSize = envInteger("CONTENT_BATCH_SIZE", 5, 25);
  const maxAttempts = envInteger("MAX_ATTEMPTS", 5, 20);
  const database = new SupabaseRestClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey());
  const threads = new ThreadsClient(
    requiredEnv("THREADS_ACCESS_TOKEN"),
    requiredEnv("THREADS_USER_ID"),
  );
  const items = await database.claimDueContent(batchSize, maxAttempts);
  let published = 0;
  let failed = 0;

  for (const item of items) {
    try {
      let containerId = item.container_id;
      if (!containerId) {
        containerId = await threads.createContainer(item.text, { mediaUrl: item.media_url });
        await database.updateContent(item.id, { container_id: containerId });
      }

      const postId = await threads.publishContainer(containerId);
      await database.updateContent(item.id, {
        threads_post_id: postId,
        status: "published",
        published_at: new Date().toISOString(),
        processing_started_at: null,
        next_retry_at: null,
        last_error: null,
      });
      published += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        event: "content_failed",
        content_id: item.id,
        message: message(error),
      }));
      await database.markContentFailed(item.id, message(error), maxAttempts);
    }
  }

  return { claimed: items.length, published, failed };
}
