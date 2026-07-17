import type { ContentProfile, ContentRow, InteractionRow } from "./types.ts";

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

  async insertInteractionsIfAbsent(values: Record<string, unknown>[]): Promise<number> {
    if (values.length === 0) return 0;
    const inserted = await this.request<Array<{ id: string }>>(
      "interactions?on_conflict=source_item_id&select=id",
      {
        method: "POST",
        body: values,
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    return inserted.length;
  }

  async getActiveContentProfile(): Promise<ContentProfile | null> {
    const rows = await this.request<ContentProfile[]>(
      "content_profiles?is_active=eq.true&select=id,business_context,target_audience,tone_of_voice,publish_times_utc&limit=1",
    );
    return rows[0] ?? null;
  }

  async getRecentContentTexts(limit = 10): Promise<string[]> {
    const rows = await this.request<Array<{ text: string }>>(
      [
        "content_queue?status=in.(draft,scheduled,publishing,published)",
        "select=text",
        "order=created_at.desc",
        `limit=${Math.max(1, Math.min(limit, 25))}`,
      ].join("&"),
    );
    return rows.map((row) => row.text);
  }

  async getFutureGeneratedKeys(from: string, until: string): Promise<string[]> {
    const rows = await this.request<Array<{ generation_key: string }>>(
      [
        "content_queue?origin=eq.ai_generated",
        "generation_key=not.is.null",
        `scheduled_at=gte.${encodeURIComponent(from)}`,
        `scheduled_at=lte.${encodeURIComponent(until)}`,
        "select=generation_key",
      ].join("&"),
    );
    return rows.map((row) => row.generation_key);
  }

  async insertGeneratedContent(values: Record<string, unknown>): Promise<boolean> {
    const inserted = await this.request<Array<{ id: string }>>(
      "content_queue?on_conflict=generation_key&select=id",
      {
        method: "POST",
        body: values,
        prefer: "resolution=ignore-duplicates,return=representation",
      },
    );
    return inserted.length > 0;
  }
}
