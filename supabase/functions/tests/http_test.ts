import { responseError } from "../_shared/http.ts";
import { assertEquals } from "./assert.ts";

Deno.test("API error formatter keeps safe Meta diagnostics", () => {
  assertEquals(
    responseError(JSON.stringify({
      error: {
        message: "API access blocked.",
        type: "OAuthException",
        code: 200,
        error_subcode: 123,
        fbtrace_id: "trace-id",
      },
    })),
    "API access blocked. (type=OAuthException, code=200, subcode=123, trace=trace-id)",
  );
});

Deno.test("API error formatter handles plain and invalid bodies", () => {
  assertEquals(responseError('{"message":"Request failed"}'), "Request failed");
  assertEquals(responseError("plain error"), "plain error");
  assertEquals(responseError(""), "Unknown API error");
});
