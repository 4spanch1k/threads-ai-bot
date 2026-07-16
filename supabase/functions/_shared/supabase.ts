import type { ContentRow, InteractionRow } from "./types.ts";

interface RequestOptions {
  method?: string;
  body?: unknown;
  prefer?: string;
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string };
    return [parsed.code, parsed.message].filter(Boolean).join(": ").slice(0, 1000);
  } catch {
    return body.slice(0, 1000) || "Unknown Supabase error";
  }
}

export class SupabaseRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers({
      apikey: this.apiKey,
      "content-type": "application/json",
      "accept-profile": "public",
      "content-profile": "public",
    });
    if (!this.apiKey.startsWith("sb_secret_")) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }
    if (options.prefer) headers.set("prefer", options.prefer);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/rest/v1/${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error("Supabase request failed");
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Supabase ${response.status}: ${errorMessage(raw)}`);
    }
    return (raw ? JSON.parse(raw) : undefined) as T;
  }

  private rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(`rpc/${name}`, { method: "POST", body });
  }

  claimInteractions(batchSize: number, maxAttempts: number): Promise<InteractionRow[]> {
    return this.rpc<InteractionRow[]>("claim_interactions", {
      batch_size: batchSize,
      max_attempts: maxAttempts,
      stale_lock_minutes: 10,
    });
  }

  claimDueContent(batchSize: number, maxAttempts: number): Promise<ContentRow[]> {
    return this.rpc<ContentRow[]>("claim_due_content", {
      batch_size: batchSize,
      max_attempts: maxAttempts,
      stale_lock_minutes: 15,
    });
  }

  updateInteraction(id: string, values: Record<string, unknown>): Promise<void> {
    return this.request<void>(`interactions?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: values,
      prefer: "return=minimal",
    });
  }

  updateContent(id: string, values: Record<string, unknown>): Promise<void> {
    return this.request<void>(`content_queue?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: values,
      prefer: "return=minimal",
    });
  }

  markInteractionFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    return this.rpc<void>("mark_interaction_failed", {
      p_id: id,
      p_error: error.slice(0, 4000),
      p_max_attempts: maxAttempts,
    });
  }

  markContentFailed(id: string, error: string, maxAttempts: number): Promise<void> {
    return this.rpc<void>("mark_content_failed", {
      p_id: id,
      p_error: error.slice(0, 4000),
      p_max_attempts: maxAttempts,
    });
  }

  insertKeywordInteraction(values: Record<string, unknown>): Promise<void> {
    return this.request<void>("interactions?on_conflict=source_item_id", {
      method: "POST",
      body: values,
      prefer: "resolution=ignore-duplicates,return=minimal",
    });
  }
}
