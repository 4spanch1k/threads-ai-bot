import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const env = {
  META_APP_SECRET: "app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "verify-token",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  LOG_WEBHOOK_PAYLOADS: "false",
  THREADS_APP_ID: "963373790065034",
  THREADS_OAUTH_REDIRECT_URI: "https://worker.example/oauth/callback",
} satisfies Env;

async function sign(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bytes);
  return `sha256=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedRequest(payload: Record<string, unknown>): Promise<string> {
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify({
    algorithm: "HMAC-SHA256",
    ...payload,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  return `${toBase64Url(new Uint8Array(signature))}.${encodedPayload}`;
}

describe("Threads webhook Worker", () => {
  it("serves a public privacy policy", async () => {
    const response = await worker.fetch(new Request("https://worker.example/privacy"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await response.text();
    expect(page).toContain("Privacy Policy");
    expect(page).toContain("https://wa.me/77089508019");
  });

  it("rejects non-GET privacy policy requests", async () => {
    const response = await worker.fetch(new Request("https://worker.example/privacy", {
      method: "POST",
    }), env);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("starts OAuth with a signed state and secure nonce cookie", async () => {
    const response = await worker.fetch(new Request("https://worker.example/oauth/start"), env);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://threads.net");
    expect(location.searchParams.get("client_id")).toBe(env.THREADS_APP_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(env.THREADS_OAUTH_REDIRECT_URI);
    expect(location.searchParams.get("scope")).toContain("threads_manage_mentions");
    expect(location.searchParams.get("state")).toContain(".");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
  });

  it("rejects an OAuth callback without its nonce cookie", async () => {
    const start = await worker.fetch(new Request("https://worker.example/oauth/start"), env);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");

    const response = await worker.fetch(
      new Request(`https://worker.example/oauth/callback?code=test-code&state=${encodeURIComponent(state ?? "")}`),
      env,
    );

    expect(response.status).toBe(403);
  });

  it("exchanges a valid OAuth callback for a long-lived token", async () => {
    const start = await worker.fetch(new Request("https://worker.example/oauth/start"), env);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
    const setCookie = start.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";", 1)[0];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://graph.threads.net/oauth/access_token") {
        return Response.json({ access_token: "short-token", user_id: 123456 });
      }
      return Response.json({ access_token: "long-lived-token", expires_in: 5_184_000 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request(
      `https://worker.example/oauth/callback?code=test-code&state=${encodeURIComponent(state ?? "")}`,
      { headers: { cookie } },
    ), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await response.text();
    expect(page).toContain("long-lived-token");
    expect(page).toContain("123456");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("verifies the Meta subscription challenge", async () => {
    const request = new Request(
      "https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345",
    );

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("12345");
  });

  it("rejects an invalid webhook signature", async () => {
    const request = new Request("https://worker.example/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=invalid" },
      body: JSON.stringify({ entry: [] }),
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
  });

  it("inserts a valid reply once through Supabase upsert semantics", async () => {
    const body = JSON.stringify({
      entry: [{
        changes: [{
          field: "replies",
          value: {
            id: "reply-42",
            text: "Сколько стоит разработка сайта?",
            username: "prospect",
            root_post: { id: "post-10" },
          },
        }],
      }],
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 201 })
    ));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://worker.example/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await sign(body),
      },
      body,
    }), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("on_conflict=source_item_id");
    expect(init?.headers).toMatchObject({ Prefer: "resolution=ignore-duplicates,return=minimal" });
  });

  it("uses a new Supabase secret key only in the apikey header", async () => {
    const secretKeyEnv = {
      ...env,
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test-key",
    };
    const body = JSON.stringify({
      entry: [{ changes: [{ field: "mentions", value: { id: "mention-1", text: "Нужен сайт" } }] }],
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(new Request("https://worker.example/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await sign(body),
      },
      body,
    }), secretKeyEnv);

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({ apikey: "sb_secret_test-key" });
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("accepts a valid Meta data deletion callback", async () => {
    const body = new URLSearchParams({
      signed_request: await signedRequest({ user_id: "threads-user-1" }),
    });

    const response = await worker.fetch(new Request("https://worker.example/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }), env);

    expect(response.status).toBe(200);
    const result = await response.json<{ url: string; confirmation_code: string }>();
    expect(result.url).toContain("/data-deletion/status?code=");
    expect(result.confirmation_code).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects a forged Meta data deletion callback", async () => {
    const response = await worker.fetch(new Request("https://worker.example/data-deletion", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: "invalid.payload" }),
    }), env);

    expect(response.status).toBe(401);
  });

  it("exposes callback readiness pages over GET", async () => {
    const deauthorize = await worker.fetch(
      new Request("https://worker.example/oauth/deauthorize"),
      env,
    );
    const deletion = await worker.fetch(
      new Request("https://worker.example/data-deletion"),
      env,
    );

    expect(deauthorize.status).toBe(200);
    expect(deletion.status).toBe(200);
  });
});
