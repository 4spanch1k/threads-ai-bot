import { runContentPoster } from "../content-poster/job.ts";
import { assertEquals } from "./assert.ts";

Deno.test("content poster skips before loading secrets in shadow mode", async () => {
  const previous = Deno.env.get("SHADOW_MODE");
  Deno.env.set("SHADOW_MODE", "true");

  try {
    assertEquals(await runContentPoster(), {
      claimed: 0,
      published: 0,
      skipped: true,
      failed: 0,
    });
  } finally {
    if (previous === undefined) Deno.env.delete("SHADOW_MODE");
    else Deno.env.set("SHADOW_MODE", previous);
  }
});
