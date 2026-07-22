import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function extensionFromMimeType(mimeType) {
  if (/png/i.test(mimeType)) return ".png";
  if (/webp/i.test(mimeType)) return ".webp";
  if (/gif/i.test(mimeType)) return ".gif";
  return ".jpg";
}

function fetchTelegramFilePath({ baseUrl, botToken, fileId, fetchImpl }) {
  return fetchImpl(`${baseUrl}/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
}

function runTesseract(imagePath, { tesseractPath, languages, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(tesseractPath, [
      imagePath,
      "stdout",
      "-l",
      languages,
      "--psm",
      "6",
    ]);
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Tesseract OCR timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Tesseract exited with ${code}`));
        return;
      }

      resolve(Buffer.concat(stdout).toString("utf8").trim());
    });
  });
}

export class LocalTesseractTelegramImageOcr {
  constructor({
    botToken,
    baseUrl = "https://api.telegram.org",
    fetchImpl = fetch,
    tesseractPath = "tesseract",
    languages = "rus+eng",
    timeoutMs = 20_000,
    recognizeFile,
  } = {}) {
    this.botToken = botToken;
    this.baseUrl = baseUrl;
    this.fetchImpl = fetchImpl;
    this.tesseractPath = tesseractPath;
    this.languages = languages;
    this.timeoutMs = timeoutMs;
    this.recognizeFile =
      recognizeFile ??
      ((imagePath) => runTesseract(imagePath, {
        tesseractPath: this.tesseractPath,
        languages: this.languages,
        timeoutMs: this.timeoutMs,
      }));
  }

  async recognizeTelegramImage({ fileId, mimeType = "image/jpeg" } = {}) {
    if (!this.botToken) {
      return { ok: false, error: "telegram_bot_token_missing" };
    }

    if (!fileId) {
      return { ok: false, error: "telegram_image_file_id_missing" };
    }

    const fileResponse = await fetchTelegramFilePath({
      baseUrl: this.baseUrl,
      botToken: this.botToken,
      fileId,
      fetchImpl: this.fetchImpl,
    });
    if (!fileResponse.ok) {
      return { ok: false, error: `telegram_get_file_failed_${fileResponse.status}` };
    }

    const filePayload = await fileResponse.json();
    const filePath = filePayload.result?.file_path;
    if (!filePath) {
      return { ok: false, error: "telegram_file_path_missing" };
    }

    const downloadResponse = await this.fetchImpl(
      `${this.baseUrl}/file/bot${this.botToken}/${filePath}`,
    );
    if (!downloadResponse.ok) {
      return { ok: false, error: `telegram_file_download_failed_${downloadResponse.status}` };
    }

    const tempDirectory = path.join(tmpdir(), "family-ai-ocr");
    await mkdir(tempDirectory, { recursive: true });
    const imagePath = path.join(
      tempDirectory,
      `${Date.now()}-${Math.random().toString(16).slice(2)}${extensionFromMimeType(mimeType)}`,
    );

    try {
      const imageBuffer = Buffer.from(await downloadResponse.arrayBuffer());
      await writeFile(imagePath, imageBuffer);
      const text = await this.recognizeFile(imagePath);

      return {
        ok: Boolean(text),
        text,
        error: text ? undefined : "ocr_empty",
      };
    } catch (error) {
      return {
        ok: false,
        error: "ocr_failed",
        text: error.message,
      };
    } finally {
      await rm(imagePath, { force: true }).catch(() => {});
    }
  }
}
