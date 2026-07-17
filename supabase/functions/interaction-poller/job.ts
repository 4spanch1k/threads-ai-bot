import { optionalEnv, requiredEnv, supabaseAdminKey } from "../_shared/env.ts";
import { SupabaseRestClient } from "../_shared/supabase.ts";
import {
  ThreadsClient,
  type ThreadsMention,
  type ThreadsOwnPost,
  type ThreadsReply,
} from "../_shared/threads.ts";
import type { JobResult } from "../_shared/types.ts";

const OWN_POST_LIMIT = 5;
const EVENT_LIMIT = 50;

interface PollerThreadsClient {
  ownPosts(limit: number): Promise<ThreadsOwnPost[]>;
  replies(threadId: string, limit: number): Promise<ThreadsReply[]>;
  mentions(limit: number): Promise<ThreadsMention[]>;
}

interface PollerDatabase {
  insertInteractionsIfAbsent(values: Record<string, unknown>[]): Promise<number>;
}

function normalizedUsername(username: string | undefined): string {
  return username?.trim().toLocaleLowerCase() ?? "";
}

function replyRecord(postId: string, reply: ThreadsReply): Record<string, unknown> | null {
  const replyId = reply.id?.trim();
  const text = reply.text?.trim();
  if (!replyId || !text || reply.is_reply_owned_by_me === true) return null;

  const record: Record<string, unknown> = {
    source_item_id: `reply:${replyId}`,
    source: "own_reply",
    event_type: "reply",
    post_id: postId,
    comment_text: text,
  };
  const username = reply.username?.trim();
  if (username) record.username = username;
  return record;
}

function mentionRecord(
  mention: ThreadsMention,
  ownUsername: string,
): Record<string, unknown> | null {
  const mentionId = mention.id?.trim();
  const text = mention.text?.trim();
  const username = mention.username?.trim();
  if (!mentionId || !text) return null;
  if (ownUsername && normalizedUsername(username) === ownUsername) return null;

  const record: Record<string, unknown> = {
    source_item_id: `mention:${mentionId}`,
    source: "own_reply",
    event_type: "mention",
    post_id: mentionId,
    comment_text: text,
  };
  if (username) record.username = username;
  return record;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown polling error";
}

export async function pollInteractions(options: {
  threads: PollerThreadsClient;
  database: PollerDatabase;
  ownUsername?: string;
}): Promise<JobResult> {
  const ownUsername = normalizedUsername(options.ownUsername);
  const records = new Map<string, Record<string, unknown>>();
  let failed = 0;

  const [postsResult, mentionsResult] = await Promise.allSettled(
    [
      options.threads.ownPosts(OWN_POST_LIMIT),
      options.threads.mentions(EVENT_LIMIT),
    ] as const,
  );

  if (postsResult.status === "fulfilled") {
    for (const post of postsResult.value) {
      const postId = post.id?.trim();
      if (!postId || post.has_replies !== true) continue;
      try {
        const replies = await options.threads.replies(postId, EVENT_LIMIT);
        for (const reply of replies) {
          const record = replyRecord(postId, reply);
          if (record) records.set(String(record.source_item_id), record);
        }
      } catch (error) {
        failed += 1;
        console.error(JSON.stringify({ event: "reply_poll_failed", message: message(error) }));
      }
    }
  } else {
    failed += 1;
    console.error(JSON.stringify({
      event: "own_posts_poll_failed",
      message: message(postsResult.reason),
    }));
  }

  if (mentionsResult.status === "fulfilled") {
    for (const mention of mentionsResult.value) {
      const record = mentionRecord(mention, ownUsername);
      if (record) records.set(String(record.source_item_id), record);
    }
  } else {
    failed += 1;
    console.error(JSON.stringify({
      event: "mention_poll_failed",
      message: message(mentionsResult.reason),
    }));
  }

  const inserted = await options.database.insertInteractionsIfAbsent([...records.values()]);
  return { inserted, failed };
}

export function runInteractionPoller(): Promise<JobResult> {
  return pollInteractions({
    threads: new ThreadsClient(
      requiredEnv("THREADS_ACCESS_TOKEN"),
      requiredEnv("THREADS_USER_ID"),
    ),
    database: new SupabaseRestClient(requiredEnv("SUPABASE_URL"), supabaseAdminKey()),
    ownUsername: optionalEnv("OWN_THREADS_USERNAME"),
  });
}
