const defaultTelegramBaseUrl = "https://api.telegram.org";
const defaultMaxDocumentBytes = 512 * 1024;

const supportedTextMimeTypes = new Set([
  "application/json",
  "application/x-ndjson",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
]);

function isSupportedTextDocument({ fileName, mimeType }) {
  const normalizedMimeType = String(mimeType ?? "").toLowerCase();
  if (normalizedMimeType.startsWith("text/")) return true;
  if (supportedTextMimeTypes.has(normalizedMimeType)) return true;
  return /\.(?:csv|json|md|markdown|txt)$/i.test(String(fileName ?? ""));
}

function titleFromFileName(fileName) {
  return String(fileName ?? "Telegram material")
    .replace(/\.[^.]+$/g, "")
    .trim() || "Telegram material";
}

export class TelegramTextDocumentExtractor {
  constructor({
    botToken,
    baseUrl = defaultTelegramBaseUrl,
    fetchImpl = fetch,
    maxBytes = defaultMaxDocumentBytes,
  } = {}) {
    this.botToken = botToken;
    this.baseUrl = baseUrl.replace(/\/+$/g, "");
    this.fetchImpl = fetchImpl;
    this.maxBytes = maxBytes;
  }

  async extractTelegramDocument({ fileId, fileName, mimeType, fileSize }) {
    if (!this.botToken) {
      throw new Error("Telegram bot token is required for document extraction");
    }

    if (!isSupportedTextDocument({ fileName, mimeType })) {
      return {
        ok: false,
        error: "unsupported_document_type",
        text: "Пока я могу читать для обучения только текстовые файлы: .txt, .md, .csv, .json.",
      };
    }

    if (fileSize != null && Number(fileSize) > this.maxBytes) {
      return {
        ok: false,
        error: "document_too_large",
        text: `Файл слишком большой для быстрого обучения из Telegram. Лимит: ${Math.round(this.maxBytes / 1024)} КБ.`,
      };
    }

    const fileResponse = await this.fetchImpl(
      `${this.baseUrl}/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    if (!fileResponse.ok) {
      throw new Error(`Telegram getFile failed with ${fileResponse.status}`);
    }

    const filePayload = await fileResponse.json();
    const filePath = filePayload?.result?.file_path;
    if (!filePath) {
      throw new Error("Telegram getFile response does not contain file_path");
    }

    const downloadResponse = await this.fetchImpl(
      `${this.baseUrl}/file/bot${this.botToken}/${filePath}`,
    );
    if (!downloadResponse.ok) {
      throw new Error(`Telegram file download failed with ${downloadResponse.status}`);
    }

    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    if (buffer.length > this.maxBytes) {
      return {
        ok: false,
        error: "document_too_large",
        text: `Файл слишком большой для быстрого обучения из Telegram. Лимит: ${Math.round(this.maxBytes / 1024)} КБ.`,
      };
    }

    return {
      ok: true,
      text: buffer.toString("utf8").replace(/\u0000/g, "").trim(),
      title: titleFromFileName(fileName),
      mimeType: mimeType ?? "text/plain",
    };
  }
}
