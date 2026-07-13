const MAX_BODY_BYTES = 256 * 1024;
const MAX_META_CALLBACK_BODY_BYTES = 16 * 1024;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const OAUTH_NONCE_COOKIE = "threads_oauth_nonce";
const THREADS_OAUTH_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_keyword_search",
  "threads_read_replies",
  "threads_manage_replies",
  "threads_manage_mentions",
].join(",");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type JsonRecord = Record<string, unknown>;

type InteractionInsert = {
  source_item_id: string;
  source: "own_reply";
  event_type: "reply" | "mention";
  comment_text: string;
  post_id?: string;
  username?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(record: JsonRecord, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function firstString(record: JsonRecord, paths: readonly (readonly string[])[]): string | undefined {
  for (const path of paths) {
    const value = getPath(record, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function normalizeEventType(rawField: string | undefined): "reply" | "mention" | undefined {
  const field = rawField?.toLowerCase();
  if (field?.includes("mention")) {
    return "mention";
  }
  if (field?.includes("repl") || field?.includes("comment")) {
    return "reply";
  }
  return undefined;
}

function extractInteractions(payload: unknown): InteractionInsert[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) {
    return [];
  }

  const interactions: InteractionInsert[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) {
      continue;
    }

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) {
        continue;
      }

      const value = change.value;
      const rawField = firstString(change, [["field"]]) ?? firstString(value, [["event_type"], ["type"]]);
      const eventType = normalizeEventType(rawField);
      if (!eventType) {
        continue;
      }

      const itemId = firstString(value, [
        ["id"],
        ["reply_id"],
        ["comment_id"],
        ["media_id"],
        ["thread_id"],
        ["post_id"],
        ["reply", "id"],
        ["media", "id"],
      ]);
      const text = firstString(value, [
        ["text"],
        ["message"],
        ["comment_text"],
        ["reply", "text"],
        ["media", "text"],
      ]);

      if (!itemId || !text) {
        console.warn(JSON.stringify({
          message: "unsupported Threads webhook change",
          field: rawField ?? "unknown",
          has_item_id: Boolean(itemId),
          has_text: Boolean(text),
        }));
        continue;
      }

      const postId = firstString(value, [
        ["post_id"],
        ["root_post", "id"],
        ["replied_to", "id"],
        ["media", "id"],
        ["parent_id"],
      ]);
      const username = firstString(value, [
        ["username"],
        ["from", "username"],
        ["user", "username"],
        ["reply", "username"],
      ]);

      const interaction: InteractionInsert = {
        source_item_id: `${eventType}:${itemId}`,
        source: "own_reply",
        event_type: eventType,
        comment_text: text,
      };
      if (postId) {
        interaction.post_id = postId;
      }
      if (username) {
        interaction.username = username;
      }
      interactions.push(interaction);
    }
  }

  return interactions;
}

async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function expectedSignature(body: ArrayBuffer, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, body);
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function verifyMetaSignature(
  body: ArrayBuffer,
  providedSignature: string | null,
  secret: string,
): Promise<boolean> {
  const expected = await expectedSignature(body, secret);
  return secureEqual(providedSignature ?? "", expected);
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function hmacSign(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return new Uint8Array(signature);
}

async function createOAuthState(nonce: string, secret: string): Promise<string> {
  const payload = encodeBase64Url(encoder.encode(JSON.stringify({
    nonce,
    expires_at: Math.floor(Date.now() / 1_000) + OAUTH_STATE_TTL_SECONDS,
  })));
  const signature = encodeBase64Url(await hmacSign(payload, secret));
  return `${payload}.${signature}`;
}

function cookieValue(request: Request, name: string): string | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }
  return undefined;
}

async function verifyOAuthState(state: string, nonce: string, secret: string): Promise<boolean> {
  const [encodedPayload, encodedSignature, ...extraSegments] = state.split(".");
  if (!encodedPayload || !encodedSignature || extraSegments.length > 0) {
    return false;
  }

  let signature: Uint8Array;
  let payload: unknown;
  try {
    signature = decodeBase64Url(encodedSignature);
    payload = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload)));
  } catch {
    return false;
  }
  if (!isRecord(payload)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(encodedPayload),
  );
  const stateNonce = typeof payload.nonce === "string" ? payload.nonce : "";
  const expiresAt = typeof payload.expires_at === "number" ? payload.expires_at : 0;

  return signatureValid
    && expiresAt >= Math.floor(Date.now() / 1_000)
    && await secureEqual(stateNonce, nonce);
}

function noStoreHeaders(contentType: string): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function jsonRecord(response: Response): Promise<JsonRecord> {
  if (!response.ok) {
    throw new Error(`Meta OAuth request failed (${response.status})`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_META_CALLBACK_BODY_BYTES) {
    throw new Error("Meta OAuth response was too large");
  }

  if (!response.body) {
    throw new Error("Meta OAuth response was empty");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_META_CALLBACK_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Meta OAuth response was too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(body));
  } catch {
    throw new Error("Meta OAuth response was invalid");
  }
  if (!isRecord(value)) {
    throw new Error("Meta OAuth response was invalid");
  }
  return value;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RangeError("Payload too large");
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw new RangeError("Payload too large");
  }
  return body;
}

async function parseSignedRequest(request: Request, secret: string): Promise<JsonRecord | undefined> {
  const rawBody = await readBoundedBody(request, MAX_META_CALLBACK_BODY_BYTES);
  const signedRequest = new URLSearchParams(decoder.decode(rawBody)).get("signed_request");
  if (!signedRequest) {
    return undefined;
  }

  const [encodedSignature, encodedPayload, ...extraSegments] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload || extraSegments.length > 0) {
    return undefined;
  }

  let signature: Uint8Array;
  let payloadBytes: Uint8Array;
  try {
    signature = decodeBase64Url(encodedSignature);
    payloadBytes = decodeBase64Url(encodedPayload);
  } catch {
    return undefined;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(encodedPayload),
  );
  if (!isValid) {
    return undefined;
  }

  try {
    const payload: unknown = JSON.parse(decoder.decode(payloadBytes));
    if (!isRecord(payload) || payload.algorithm !== "HMAC-SHA256") {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

async function insertInteractions(env: Env, interactions: readonly InteractionInsert[]): Promise<void> {
  if (interactions.length === 0) {
    return;
  }

  const endpoint = new URL("/rest/v1/interactions", env.SUPABASE_URL);
  endpoint.searchParams.set("on_conflict", "source_item_id");

  const authorizationHeader = env.SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_secret_")
    ? {}
    : { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      ...authorizationHeader,
      "Content-Type": "application/json",
      "Content-Profile": "public",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(interactions),
  });

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 1_000);
    throw new Error(`Supabase insert failed (${response.status}): ${errorBody}`);
  }
}

async function handleVerification(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge");

  const tokenMatches = await secureEqual(token, env.META_WEBHOOK_VERIFY_TOKEN);
  if (mode !== "subscribe" || !challenge || !tokenMatches) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function handleOAuthStart(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }

  const nonce = randomToken();
  const state = await createOAuthState(nonce, env.META_APP_SECRET);
  const authorizationUrl = new URL("https://threads.net/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", env.THREADS_APP_ID);
  authorizationUrl.searchParams.set("redirect_uri", env.THREADS_OAUTH_REDIRECT_URI);
  authorizationUrl.searchParams.set("scope", THREADS_OAUTH_SCOPES);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Location: authorizationUrl.toString(),
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `${OAUTH_NONCE_COOKIE}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/oauth/callback; Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
    },
  });
}

function oauthResultPage(accessToken: string, userId: string, expiresIn: number | undefined): string {
  const expiryText = expiresIn
    ? `Срок действия: примерно ${Math.floor(expiresIn / 86_400)} дней.`
    : "Срок действия вернул Meta API.";
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Threads token готов</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #f5f7fa; }
    main { width: min(760px, calc(100% - 32px)); padding: 32px; border: 1px solid #29313a; border-radius: 20px; background: #131820; box-sizing: border-box; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { color: #b8c2cc; line-height: 1.55; }
    label { display: block; margin: 24px 0 8px; font-weight: 700; }
    textarea, code { width: 100%; box-sizing: border-box; border: 1px solid #34404c; border-radius: 12px; background: #090c10; color: #eaf2f8; padding: 14px; font: 14px/1.5 ui-monospace, monospace; }
    textarea { min-height: 132px; resize: vertical; }
    .warning { margin-top: 24px; padding: 14px 16px; border-radius: 12px; background: #2a210d; color: #ffd98a; }
  </style>
</head>
<body>
  <main>
    <h1>Threads-токен готов</h1>
    <p>${escapeHtml(expiryText)} Скопируй оба значения в безопасное место и не отправляй их в чат.</p>
    <label for="token">THREADS_ACCESS_TOKEN</label>
    <textarea id="token" readonly>${escapeHtml(accessToken)}</textarea>
    <label>THREADS_USER_ID</label>
    <code>${escapeHtml(userId)}</code>
    <p class="warning">Закрой эту вкладку после копирования. Следующим шагом добавим значения напрямую в GitHub Secrets.</p>
  </main>
</body>
</html>`;
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const nonce = cookieValue(request, OAUTH_NONCE_COOKIE) ?? "";
  if (!code || !state || !nonce || !await verifyOAuthState(state, nonce, env.META_APP_SECRET)) {
    return Response.json(
      { error: "Invalid or expired OAuth callback. Start again at /oauth/start." },
      { status: 403, headers: noStoreHeaders("application/json; charset=utf-8") },
    );
  }

  const tokenBody = new URLSearchParams({
    client_id: env.THREADS_APP_ID,
    client_secret: env.META_APP_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: env.THREADS_OAUTH_REDIRECT_URI,
  });
  const shortTokenResponse = await fetch("https://graph.threads.net/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });
  const shortTokenPayload = await jsonRecord(shortTokenResponse);
  const shortToken = typeof shortTokenPayload.access_token === "string"
    ? shortTokenPayload.access_token
    : "";
  const userIdValue = shortTokenPayload.user_id;
  const userId = typeof userIdValue === "string" || typeof userIdValue === "number"
    ? String(userIdValue)
    : "";
  if (!shortToken || !userId) {
    throw new Error("Meta OAuth response did not contain a token and user ID");
  }

  const exchangeUrl = new URL("https://graph.threads.net/access_token");
  exchangeUrl.searchParams.set("grant_type", "th_exchange_token");
  exchangeUrl.searchParams.set("client_secret", env.META_APP_SECRET);
  exchangeUrl.searchParams.set("access_token", shortToken);
  const longTokenPayload = await jsonRecord(await fetch(exchangeUrl));
  const longToken = typeof longTokenPayload.access_token === "string"
    ? longTokenPayload.access_token
    : "";
  const expiresIn = typeof longTokenPayload.expires_in === "number"
    ? longTokenPayload.expires_in
    : undefined;
  if (!longToken) {
    throw new Error("Meta OAuth exchange did not contain a long-lived token");
  }

  return new Response(oauthResultPage(longToken, userId, expiresIn), {
    status: 200,
    headers: {
      ...noStoreHeaders("text/html; charset=utf-8"),
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Set-Cookie": `${OAUTH_NONCE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/oauth/callback; Max-Age=0`,
    },
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  let rawBody: ArrayBuffer;
  try {
    rawBody = await readBoundedBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RangeError) {
      return Response.json({ error: "Payload too large" }, { status: 413 });
    }
    throw error;
  }
  if (rawBody.byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  const isValid = await verifyMetaSignature(
    rawBody,
    request.headers.get("x-hub-signature-256"),
    env.META_APP_SECRET,
  );
  if (!isValid) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const rawText = decoder.decode(rawBody);
  if (env.LOG_WEBHOOK_PAYLOADS === "true") {
    console.log(JSON.stringify({ message: "Threads webhook raw payload", payload: rawText }));
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const interactions = extractInteractions(payload);
  await insertInteractions(env, interactions);

  console.log(JSON.stringify({
    message: "Threads webhook ingested",
    accepted: interactions.length,
    payload_bytes: rawBody.byteLength,
  }));
  return Response.json({ accepted: interactions.length });
}

async function handleDeauthorization(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({ status: "ready", purpose: "Meta deauthorization callback" });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  }

  const payload = await parseSignedRequest(request, env.META_APP_SECRET);
  if (!payload) {
    return Response.json({ error: "Invalid signed request" }, { status: 401 });
  }

  console.log(JSON.stringify({
    message: "Meta deauthorization acknowledged",
    has_user_id: typeof payload.user_id === "string" || typeof payload.user_id === "number",
  }));
  return Response.json({ success: true });
}

async function handleDataDeletion(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({
      status: "ready",
      purpose: "Meta user data deletion callback",
      data_policy: "No OAuth user profile or access token is stored by this service.",
    });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  }

  const payload = await parseSignedRequest(request, env.META_APP_SECRET);
  if (!payload) {
    return Response.json({ error: "Invalid signed request" }, { status: 401 });
  }

  const confirmationCode = crypto.randomUUID();
  const statusUrl = new URL("/data-deletion/status", request.url);
  statusUrl.searchParams.set("code", confirmationCode);

  console.log(JSON.stringify({
    message: "Meta data deletion request completed",
    confirmation_code: confirmationCode,
    has_user_id: typeof payload.user_id === "string" || typeof payload.user_id === "number",
  }));
  return Response.json({
    url: statusUrl.toString(),
    confirmation_code: confirmationCode,
  });
}

function handleDataDeletionStatus(request: Request): Response {
  const code = new URL(request.url).searchParams.get("code") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(code)) {
    return Response.json({ error: "Invalid confirmation code" }, { status: 400 });
  }
  return Response.json({ confirmation_code: code, status: "completed" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook") {
        if (request.method === "GET") {
          return await handleVerification(request, env);
        }
        if (request.method === "POST") {
          return await handleWebhook(request, env);
        }
        return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      }
      if (url.pathname === "/oauth/start") {
        return await handleOAuthStart(request, env);
      }
      if (url.pathname === "/oauth/callback") {
        return await handleOAuthCallback(request, env);
      }
      if (url.pathname === "/oauth/deauthorize") {
        return await handleDeauthorization(request, env);
      }
      if (url.pathname === "/data-deletion") {
        return await handleDataDeletion(request, env);
      }
      if (url.pathname === "/data-deletion/status" && request.method === "GET") {
        return handleDataDeletionStatus(request);
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof RangeError) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(JSON.stringify({ message: "Worker request failed", path: url.pathname, error: message }));
      return Response.json({ error: "Temporary request failure" }, { status: 503 });
    }
  },
} satisfies ExportedHandler<Env>;
