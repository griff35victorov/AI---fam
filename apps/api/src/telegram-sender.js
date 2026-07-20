export class TelegramBotSender {
  constructor({ botToken, baseUrl = "https://api.telegram.org", fetchImpl = fetch } = {}) {
    this.botToken = botToken;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
  }

  async sendMessage({ chatId, text }) {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed with ${response.status}`);
    }

    return response.json();
  }
}
