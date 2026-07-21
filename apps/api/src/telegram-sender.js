export class TelegramBotSender {
  constructor({
    botToken,
    baseUrl = "https://api.telegram.org",
    fetchImpl = fetch,
    maxAttempts = 3,
    retryDelayMs = 500,
  } = {}) {
    this.botToken = botToken;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
  }

  async sendMessage({ chatId, text }) {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    const attempts = Math.max(1, Number(this.maxAttempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });

        if (response.ok) {
          return response.json();
        }

        lastError = new Error(`Telegram sendMessage failed with ${response.status}`);
        if (!telegramStatusIsRetryable(response.status) || attempt === attempts) {
          throw lastError;
        }
      } catch (error) {
        lastError =
          error === lastError
            ? error
            : new Error(`Telegram sendMessage network failed: ${error.message}`, {
                cause: error,
              });

        if (attempt === attempts || error === lastError) {
          throw lastError;
        }
      }

      await delay(this.retryDelayMs);
    }

    throw lastError;
  }
}

function telegramStatusIsRetryable(status) {
  return status === 429 || status >= 500;
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}
