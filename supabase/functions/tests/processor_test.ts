import { processInteraction, shouldNotify, shouldReply } from "../interaction-processor/job.ts";
import type { Classification, InteractionRow } from "../_shared/types.ts";
import { assertEquals } from "./assert.ts";

function interaction(overrides: Partial<InteractionRow> = {}): InteractionRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    source_item_id: "reply:123",
    source: "own_reply",
    event_type: "reply",
    post_id: "post-1",
    username: "customer",
    comment_text: "Нужен сайт",
    intent: null,
    signals: [],
    risk_flags: [],
    confidence_level: null,
    bot_reply_text: null,
    reply_sent: false,
    notification_sent: false,
    ...overrides,
  };
}

const lead: Classification = {
  intent: "lead",
  signals: ["explicit_need"],
  riskFlags: [],
  confidenceLevel: "high",
  botReplyText: "Давайте обсудим задачу",
};

Deno.test("shadow mode persists classification without external actions", async () => {
  const updates: Array<Record<string, unknown>> = [];
  await processInteraction(interaction(), {
    classifier: { classify: () => Promise.resolve(lead) },
    database: {
      updateInteraction: (_id, values) => {
        updates.push(values);
        return Promise.resolve();
      },
    },
    shadowMode: true,
    threads: null,
    telegram: null,
    now: () => "2026-07-16T00:00:00.000Z",
  });

  assertEquals(updates.length, 1);
  assertEquals(updates[0].status, "classified");
  assertEquals(updates[0].reply_sent, undefined);
  assertEquals(updates[0].notification_sent, undefined);
});

Deno.test("keyword findings never qualify for an automatic reply", () => {
  assertEquals(shouldReply(interaction({ source: "keyword_search" }), lead), false);
  assertEquals(shouldNotify(lead), true);
});

Deno.test("risk flags notify an operator but suppress replies", () => {
  const risky: Classification = { ...lead, riskFlags: ["complaint"] };
  assertEquals(shouldReply(interaction(), risky), false);
  assertEquals(shouldNotify(risky), true);
});
