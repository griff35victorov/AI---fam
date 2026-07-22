export class TelegramBotSender {
  constructor({
    botToken,
    baseUrl = "https://api.telegram.org",
    fetchImpl = fetch,
    maxAttempts = 3,
    retryDelayMs = 500,
    timeoutMs = 5000,
  } = {}) {
    this.botToken = botToken;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.timeoutMs = timeoutMs;
  }

  async sendMessage({ chatId, text }) {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    const attempts = Math.max(1, Number(this.maxAttempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          this.fetchImpl,
          `${this.baseUrl}/bot${this.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildTelegramSendMessageBody({ chatId, text })),
          },
          this.timeoutMs,
        );

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

  async sendChatAction({ chatId, action = "typing" }) {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required");
    }

    const response = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}/bot${this.botToken}/sendChatAction`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, action }),
      },
      this.timeoutMs,
    );

    if (!response.ok) {
      throw new Error(`Telegram sendChatAction failed with ${response.status}`);
    }

    return response.json();
  }
}

export class TelegramRelaySender {
  constructor({
    relayUrl,
    relaySecret,
    botKey,
    fetchImpl = fetch,
    maxAttempts = 3,
    retryDelayMs = 500,
    timeoutMs = 5000,
  } = {}) {
    this.relayUrl = relayUrl?.replace(/\/+$/, "");
    this.relaySecret = relaySecret;
    this.botKey = botKey;
    this.fetchImpl = fetchImpl;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.timeoutMs = timeoutMs;
  }

  async sendMessage({ chatId, text }) {
    if (!this.relayUrl) {
      throw new Error("TELEGRAM_RELAY_URL is required");
    }

    if (!this.relaySecret) {
      throw new Error("TELEGRAM_RELAY_SECRET is required");
    }

    if (!this.botKey) {
      throw new Error("TELEGRAM_RELAY_BOT_KEY is required");
    }

    const attempts = Math.max(1, Number(this.maxAttempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          this.fetchImpl,
          `${this.relayUrl}/telegram/${this.botKey}/send`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-family-ai-relay-secret": this.relaySecret,
            },
            body: JSON.stringify(buildTelegramSendMessageBody({ chatId, text })),
          },
          this.timeoutMs,
        );

        if (response.ok) {
          return response.json();
        }

        lastError = new Error(`Telegram relay send failed with ${response.status}`);
        if (!telegramStatusIsRetryable(response.status) || attempt === attempts) {
          throw lastError;
        }
      } catch (error) {
        lastError =
          error === lastError
            ? error
            : new Error(`Telegram relay send network failed: ${error.message}`, {
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

export class TelegramFailoverSender {
  constructor({ primary, fallback } = {}) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async sendMessage(message) {
    if (!this.primary) {
      return this.fallback.sendMessage(message);
    }

    try {
      return await this.primary.sendMessage(message);
    } catch (primaryError) {
      if (!this.fallback) {
        throw primaryError;
      }

      return this.fallback.sendMessage(message);
    }
  }

  async sendChatAction(action) {
    if (typeof this.primary?.sendChatAction !== "function") {
      return undefined;
    }

    try {
      return await this.primary.sendChatAction(action);
    } catch {
      return undefined;
    }
  }
}

function telegramStatusIsRetryable(status) {
  return status === 429 || status >= 500;
}

function buildTelegramSendMessageBody({ chatId, text }) {
  return {
    chat_id: chatId,
    text,
    ...(hasUrl(text) ? { link_preview_options: { is_disabled: true } } : {}),
  };
}

function hasUrl(text) {
  return /https?:\/\/\S+/i.test(String(text ?? ""));
}

function delay(ms) {
  if (!ms) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return fetchImpl(url, options);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
