export function responseError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        type?: string;
        code?: string | number;
        error_subcode?: string | number;
        fbtrace_id?: string;
      };
      message?: string;
    };
    const error = parsed.error;
    const message = error?.message ?? parsed.message ?? "Unknown API error";
    const details = [
      error?.type ? `type=${error.type}` : "",
      error?.code !== undefined ? `code=${error.code}` : "",
      error?.error_subcode !== undefined ? `subcode=${error.error_subcode}` : "",
      error?.fbtrace_id ? `trace=${error.fbtrace_id}` : "",
    ].filter(Boolean);
    return `${message}${details.length > 0 ? ` (${details.join(", ")})` : ""}`.slice(0, 1000);
  } catch {
    return body.slice(0, 1000) || "Unknown API error";
  }
}

export async function fetchJson<T>(
  service: string,
  url: URL | string,
  init: RequestInit,
  timeoutMilliseconds = 30_000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    // Never include the URL: external API URLs may contain sensitive parameters.
    throw new Error(`${service} request failed`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`${service} ${response.status}: ${responseError(raw)}`);
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${service} returned invalid JSON`);
  }
}
