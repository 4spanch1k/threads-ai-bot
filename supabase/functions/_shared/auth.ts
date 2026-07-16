import { constantTimeEqual, cronSecret } from "./env.ts";

export class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function authorizeCronRequest(request: Request): void {
  if (request.method !== "POST") {
    throw new RequestError("Method not allowed", 405);
  }

  const expected = cronSecret();
  const actual = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(actual, expected)) {
    throw new RequestError("Forbidden", 403);
  }
}
