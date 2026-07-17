import { fetchJson } from "./http.ts";

interface IdResponse {
  id?: string;
}

export interface ThreadsSearchPost {
  id?: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
}

export interface ThreadsOwnPost {
  id?: string;
  timestamp?: string;
  has_replies?: boolean;
}

export interface ThreadsReply {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  is_reply_owned_by_me?: boolean;
}

export interface ThreadsMention {
  id?: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
}

interface ThreadsListResponse<T> {
  data?: T[];
}

export class ThreadsClient {
  constructor(
    private readonly accessToken: string,
    private readonly userId: string,
    private readonly baseUrl = "https://graph.threads.net",
  ) {}

  private url(path: string, parameters: Record<string, string>): URL {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(parameters)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private requestInit(method: "GET" | "POST"): RequestInit {
    return {
      method,
      headers: { authorization: `Bearer ${this.accessToken}` },
    };
  }

  async createContainer(
    text: string,
    options: { mediaUrl?: string | null; replyToId?: string } = {},
  ): Promise<string> {
    let mediaType = "TEXT";
    const parameters: Record<string, string> = { text };
    if (options.mediaUrl) {
      mediaType = /\.(mp4|mov|webm)(?:$|\?)/i.test(options.mediaUrl) ? "VIDEO" : "IMAGE";
      parameters[mediaType === "VIDEO" ? "video_url" : "image_url"] = options.mediaUrl;
    }
    parameters.media_type = mediaType;
    if (options.replyToId) parameters.reply_to_id = options.replyToId;

    const payload = await fetchJson<IdResponse>(
      "Threads API",
      this.url(`${this.userId}/threads`, parameters),
      this.requestInit("POST"),
    );
    if (!payload.id) throw new Error("Threads API returned no container id");
    return payload.id;
  }

  async publishContainer(containerId: string): Promise<string> {
    const payload = await fetchJson<IdResponse>(
      "Threads API",
      this.url(`${this.userId}/threads_publish`, { creation_id: containerId }),
      this.requestInit("POST"),
    );
    if (!payload.id) throw new Error("Threads API returned no published post id");
    return payload.id;
  }

  async reply(replyToId: string, text: string): Promise<string> {
    const containerId = await this.createContainer(text, { replyToId });
    return this.publishContainer(containerId);
  }

  async keywordSearch(
    query: string,
    searchType: "TOP" | "RECENT",
    searchMode: "KEYWORD" | "TAG",
    limit = 25,
  ): Promise<ThreadsSearchPost[]> {
    const payload = await fetchJson<ThreadsListResponse<ThreadsSearchPost>>(
      "Threads API",
      this.url("keyword_search", {
        q: query,
        search_type: searchType,
        search_mode: searchMode,
        fields: "id,text,username,permalink,timestamp",
        limit: String(limit),
      }),
      this.requestInit("GET"),
    );
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async ownPosts(limit = 5): Promise<ThreadsOwnPost[]> {
    const payload = await fetchJson<ThreadsListResponse<ThreadsOwnPost>>(
      "Threads API",
      this.url("me/threads", {
        fields: "id,timestamp,has_replies",
        limit: String(limit),
      }),
      this.requestInit("GET"),
    );
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async replies(threadId: string, limit = 50): Promise<ThreadsReply[]> {
    const payload = await fetchJson<ThreadsListResponse<ThreadsReply>>(
      "Threads API",
      this.url(`${threadId}/replies`, {
        fields: "id,text,username,timestamp,is_reply_owned_by_me",
        reverse: "true",
        limit: String(limit),
      }),
      this.requestInit("GET"),
    );
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async mentions(limit = 50): Promise<ThreadsMention[]> {
    const payload = await fetchJson<ThreadsListResponse<ThreadsMention>>(
      "Threads API",
      this.url("me/mentions", {
        fields: "id,text,username,permalink,timestamp",
        limit: String(limit),
      }),
      this.requestInit("GET"),
    );
    return Array.isArray(payload.data) ? payload.data : [];
  }
}
