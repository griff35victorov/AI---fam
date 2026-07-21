import assert from "node:assert/strict";
import test from "node:test";

import { TelegramVoiceTranscriber } from "../src/voice.js";

test("TelegramVoiceTranscriber sends model and language to STT endpoint", async () => {
  const calls = [];
  const transcriber = new TelegramVoiceTranscriber({
    botToken: "telegram-token",
    transcriptionUrl: "https://stt.example/transcriptions",
    transcriptionApiKey: "stt-key",
    transcriptionModel: "whisper-1",
    transcriptionLanguage: "ru",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });

      if (url.endsWith("/getFile")) {
        return {
          ok: true,
          json: async () => ({ result: { file_path: "voice/file.ogg" } }),
        };
      }

      if (url.includes("/file/bot")) {
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        };
      }

      return {
        ok: true,
        json: async () => ({ text: "тест голосом" }),
      };
    },
  });

  const result = await transcriber.transcribeTelegramVoice({
    fileId: "voice-file",
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "тест голосом");
  assert.equal(calls[2].url, "https://stt.example/transcriptions");
  assert.equal(calls[2].options.headers.authorization, "Bearer stt-key");
  assert.equal(await calls[2].options.body.get("model"), "whisper-1");
  assert.equal(await calls[2].options.body.get("language"), "ru");
});
