import { fetchJson } from "./http.ts";

interface TelegramResponse {
  ok?: boolean;
}

export class TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  async send(text: string): Promise<void> {
    const payload = await fetchJson<TelegramResponse>(
      "Telegram API",
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000) }),
      },
    );
    if (!payload.ok) throw new Error("Telegram API did not confirm the message");
  }
}
