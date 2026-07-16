import { authorizeCronRequest, RequestError } from "./auth.ts";
import type { JobResult } from "./types.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function handleCronJob(
  request: Request,
  jobName: string,
  run: () => Promise<JobResult>,
): Promise<Response> {
  try {
    authorizeCronRequest(request);
    const result = await run();
    const status = result.failed > 0 ? 500 : 200;
    console.log(JSON.stringify({ event: "job_complete", job: jobName, ...result }));
    return response({ ok: status === 200, job: jobName, ...result }, status);
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(JSON.stringify({ event: "job_failed", job: jobName, message }));
    return response({ ok: false, job: jobName, error: message }, status);
  }
}
