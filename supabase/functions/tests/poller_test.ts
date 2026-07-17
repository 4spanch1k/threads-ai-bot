import { pollInteractions } from "../interaction-poller/job.ts";
import type { ThreadsMention, ThreadsOwnPost, ThreadsReply } from "../_shared/threads.ts";
import { assertEquals } from "./assert.ts";

class FakeThreadsClient {
  ownPosts(): Promise<ThreadsOwnPost[]> {
    return Promise.resolve([
      { id: "post-1", has_replies: true },
      { id: "post-2", has_replies: false },
    ]);
  }

  replies(threadId: string): Promise<ThreadsReply[]> {
    assertEquals(threadId, "post-1");
    return Promise.resolve([
      { id: "reply-1", text: "Нужен сайт", username: "lead", is_reply_owned_by_me: false },
      { id: "reply-own", text: "Наш ответ", is_reply_owned_by_me: true },
      { id: "reply-empty", text: "  ", is_reply_owned_by_me: false },
    ]);
  }

  mentions(): Promise<ThreadsMention[]> {
    return Promise.resolve([
      { id: "mention-1", text: "@mononyx нужен лендинг", username: "buyer" },
      { id: "mention-own", text: "self mention", username: "Mononyx" },
    ]);
  }
}

class FakeDatabase {
  readonly sourceIds = new Set<string>();
  records: Record<string, unknown>[] = [];

  insertInteractionsIfAbsent(values: Record<string, unknown>[]): Promise<number> {
    this.records = values;
    let inserted = 0;
    for (const value of values) {
      const sourceId = String(value.source_item_id);
      if (this.sourceIds.has(sourceId)) continue;
      this.sourceIds.add(sourceId);
      inserted += 1;
    }
    return Promise.resolve(inserted);
  }
}

Deno.test("poller normalizes replies and mentions and remains idempotent", async () => {
  const database = new FakeDatabase();
  const options = {
    threads: new FakeThreadsClient(),
    database,
    ownUsername: "mononyx",
  };

  assertEquals(await pollInteractions(options), { inserted: 2, failed: 0 });
  assertEquals(database.records, [
    {
      source_item_id: "reply:reply-1",
      source: "own_reply",
      event_type: "reply",
      post_id: "post-1",
      comment_text: "Нужен сайт",
      username: "lead",
    },
    {
      source_item_id: "mention:mention-1",
      source: "own_reply",
      event_type: "mention",
      post_id: "mention-1",
      comment_text: "@mononyx нужен лендинг",
      username: "buyer",
    },
  ]);
  assertEquals(await pollInteractions(options), { inserted: 0, failed: 0 });
});

Deno.test("poller keeps successful mentions when one reply request fails", async () => {
  const database = new FakeDatabase();
  const threads = new FakeThreadsClient();
  threads.replies = () => Promise.reject(new Error("rate limited"));

  assertEquals(
    await pollInteractions({ threads, database, ownUsername: "mononyx" }),
    { inserted: 1, failed: 1 },
  );
  assertEquals(database.records[0]?.source_item_id, "mention:mention-1");
});
