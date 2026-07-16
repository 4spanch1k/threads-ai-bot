function responseError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    return (parsed.error?.message ?? parsed.message ?? "Unknown API error").slice(0, 1000);
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
