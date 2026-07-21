export const voiceInputNotConfiguredText =
  "Голосовой ввод пока не настроен. Нужно подключить speech-to-text endpoint в переменной VOICE_TRANSCRIPTION_URL.";

export class TelegramVoiceTranscriber {
  constructor({
    botToken,
    transcriptionUrl,
    transcriptionApiKey,
    transcriptionModel,
    transcriptionLanguage = "ru",
    fetchImpl = fetch,
    telegramBaseUrl = "https://api.telegram.org",
  } = {}) {
    this.botToken = botToken;
    this.transcriptionUrl = transcriptionUrl;
    this.transcriptionApiKey = transcriptionApiKey;
    this.transcriptionModel = transcriptionModel;
    this.transcriptionLanguage = transcriptionLanguage;
    this.fetchImpl = fetchImpl;
    this.telegramBaseUrl = telegramBaseUrl;
  }

  get configured() {
    return Boolean(this.botToken && this.transcriptionUrl);
  }

  async transcribeTelegramVoice({ fileId }) {
    if (!this.configured) {
      return {
        ok: false,
        error: "voice_transcription_not_configured",
        text: voiceInputNotConfiguredText,
      };
    }

    const filePath = await this.resolveTelegramFilePath(fileId);
    const fileResponse = await this.fetchImpl(
      `${this.telegramBaseUrl}/file/bot${this.botToken}/${filePath}`,
    );
    if (!fileResponse.ok) {
      throw new Error(`Telegram voice download failed with ${fileResponse.status}`);
    }

    const audioBuffer = await fileResponse.arrayBuffer();
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
    formData.append("language", this.transcriptionLanguage);
    if (this.transcriptionModel) {
      formData.append("model", this.transcriptionModel);
    }

    const headers = {};
    if (this.transcriptionApiKey) {
      headers.authorization = `Bearer ${this.transcriptionApiKey}`;
    }

    const transcriptionResponse = await this.fetchImpl(this.transcriptionUrl, {
      method: "POST",
      headers,
      body: formData,
    });
    if (!transcriptionResponse.ok) {
      throw new Error(`Voice transcription failed with ${transcriptionResponse.status}`);
    }

    const payload = await transcriptionResponse.json();
    const text = payload.text ?? payload.transcript ?? payload.result?.text ?? "";

    return {
      ok: Boolean(text.trim()),
      text: text.trim(),
      error: text.trim() ? null : "voice_transcription_empty",
    };
  }

  async resolveTelegramFilePath(fileId) {
    const response = await this.fetchImpl(`${this.telegramBaseUrl}/bot${this.botToken}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!response.ok) {
      throw new Error(`Telegram getFile failed with ${response.status}`);
    }

    const payload = await response.json();
    const filePath = payload.result?.file_path;
    if (!filePath) {
      throw new Error("Telegram getFile did not return file_path");
    }

    return filePath;
  }
}
