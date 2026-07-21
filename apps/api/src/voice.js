import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export class LocalVoskTelegramVoiceTranscriber {
  constructor({
    botToken,
    fetchImpl = fetch,
    telegramBaseUrl = "https://api.telegram.org",
    pythonPath = process.env.VOSK_PYTHON_PATH ?? "python3",
    modelPath = process.env.VOSK_MODEL_PATH ?? "/opt/vosk/model",
    timeoutMs = Number(process.env.VOSK_TRANSCRIPTION_TIMEOUT_MS ?? 25_000),
    transcribeFile,
  } = {}) {
    this.botToken = botToken;
    this.fetchImpl = fetchImpl;
    this.telegramBaseUrl = telegramBaseUrl;
    this.pythonPath = pythonPath;
    this.modelPath = modelPath;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 25_000;
    this.transcribeFile =
      transcribeFile ??
      ((audioPath) =>
        runLocalVoskTranscription({
          audioPath,
          pythonPath: this.pythonPath,
          modelPath: this.modelPath,
          timeoutMs: this.timeoutMs,
        }));
  }

  get configured() {
    return Boolean(this.botToken);
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

    const tempDir = join(tmpdir(), "family-ai-voice");
    const audioPath = join(tempDir, `${randomUUID()}.ogg`);

    await mkdir(tempDir, { recursive: true });
    await writeFile(audioPath, Buffer.from(await fileResponse.arrayBuffer()));

    try {
      const text = await this.transcribeFile(audioPath);

      return {
        ok: Boolean(text.trim()),
        text: text.trim(),
        error: text.trim() ? null : "voice_transcription_empty",
      };
    } finally {
      await rm(audioPath, { force: true });
    }
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

function localVoskScriptPath() {
  return join(dirname(fileURLToPath(import.meta.url)), "local-vosk-transcribe.py");
}

function runLocalVoskTranscription({
  audioPath,
  pythonPath,
  modelPath,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [localVoskScriptPath(), audioPath], {
      env: {
        ...process.env,
        VOSK_MODEL_PATH: modelPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Local Vosk transcription timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`Local Vosk transcription failed: ${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout).text ?? "");
      } catch (error) {
        reject(new Error(`Local Vosk returned invalid JSON: ${error.message}`));
      }
    });
  });
}
