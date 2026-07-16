import { authorizeCronRequest, RequestError } from "../_shared/auth.ts";
import { assert, assertEquals } from "./assert.ts";

function withCronSecret(run: () => void): void {
  const original = Deno.env.get("CRON_SECRET");
  Deno.env.set("CRON_SECRET", "test-cron-secret-with-sufficient-entropy");
  try {
    run();
  } finally {
    if (original === undefined) Deno.env.delete("CRON_SECRET");
    else Deno.env.set("CRON_SECRET", original);
  }
}

Deno.test("cron authorization accepts only a matching custom header", () => {
  withCronSecret(() => {
    authorizeCronRequest(
      new Request("https://example.test", {
        method: "POST",
        headers: { "x-cron-secret": "test-cron-secret-with-sufficient-entropy" },
      }),
    );
  });
});

Deno.test("cron authorization rejects an invalid secret", () => {
  withCronSecret(() => {
    try {
      authorizeCronRequest(
        new Request("https://example.test", {
          method: "POST",
          headers: { "x-cron-secret": "wrong" },
        }),
      );
      throw new Error("Expected authorization failure");
    } catch (error) {
      assert(error instanceof RequestError);
      assertEquals(error.status, 403);
    }
  });
});

Deno.test("cron authorization rejects non-POST requests", () => {
  withCronSecret(() => {
    try {
      authorizeCronRequest(new Request("https://example.test"));
      throw new Error("Expected method failure");
    } catch (error) {
      assert(error instanceof RequestError);
      assertEquals(error.status, 405);
    }
  });
});

Deno.test("cron authorization rejects a weak configured secret", () => {
  const original = Deno.env.get("CRON_SECRET");
  Deno.env.set("CRON_SECRET", "too-short");
  try {
    try {
      authorizeCronRequest(
        new Request("https://example.test", {
          method: "POST",
          headers: { "x-cron-secret": "too-short" },
        }),
      );
      throw new Error("Expected weak secret failure");
    } catch (error) {
      assert(error instanceof Error);
      assertEquals(
        error.message,
        "CRON_SECRET must contain at least 32 characters",
      );
    }
  } finally {
    if (original === undefined) Deno.env.delete("CRON_SECRET");
    else Deno.env.set("CRON_SECRET", original);
  }
});
