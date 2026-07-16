import { optionalEnv, requiredEnv, supabaseAdminKey } from "../_shared/env.ts";
import { KEYWORD_QUERIES } from "../_shared/keywords.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import { ThreadsClient } from "../_shared/threads.ts";
import type { JobResult } from "../_shared/types.ts";

export async function runKeywordRadar(): Promise<JobResult> {
  const ownUsername = (optionalEnv("OWN_THREADS_USERNAME") ?? "").toLocaleLowerCase();
  const database = new SupabaseRestClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey());
  const threads = new ThreadsClient(
    requiredEnv("THREADS_ACCESS_TOKEN"),
    requiredEnv("THREADS_USER_ID"),
  );
  let inserted = 0;

  for (const query of KEYWORD_QUERIES) {
    const posts = await threads.keywordSearch(query.query, query.searchType, query.searchMode, 25);
    for (const post of posts) {
      const postId = post.id;
      const text = post.text?.trim();
      const username = post.username?.trim();
      if (!postId || !text) continue;
      if (ownUsername && username?.toLocaleLowerCase() === ownUsername) continue;

      const record: Record<string, unknown> = {
        source_item_id: `keyword_search:${postId}`,
        source: "keyword_search",
        event_type: "keyword_hit",
        post_id: String(postId),
        comment_text: text,
        signals: [`query:${query.query}`],
      };
      if (username) record.username = username;
      await database.insertKeywordInteraction(record);
      inserted += 1;
    }
    console.log(JSON.stringify({
      event: "keyword_query_complete",
      query: query.query,
      found: posts.length,
    }));
  }

  return { inserted, failed: 0 };
}
