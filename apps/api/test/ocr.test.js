import assert from "node:assert/strict";
import test from "node:test";

import { LocalTesseractTelegramImageOcr } from "../src/ocr.js";

test("LocalTesseractTelegramImageOcr downloads Telegram image and recognizes it locally", async () => {
  const calls = [];
  const recognizedFiles = [];
  const ocr = new LocalTesseractTelegramImageOcr({
    botToken: "telegram-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });

      if (url.endsWith("/getFile")) {
        return {
          ok: true,
          json: async () => ({ result: { file_path: "photos/file.jpg" } }),
        };
      }

      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    },
    recognizeFile: async (imagePath) => {
      recognizedFiles.push(imagePath);
      return "распознанный текст";
    },
  });

  const result = await ocr.recognizeTelegramImage({
    fileId: "photo-file",
    mimeType: "image/jpeg",
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "распознанный текст");
  assert.equal(calls.length, 2);
  assert.match(recognizedFiles[0], /\.jpg$/);
});
