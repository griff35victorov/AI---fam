import assert from "node:assert/strict";
import test from "node:test";

import { TelegramTextDocumentExtractor } from "../src/telegram-documents.js";

test("TelegramTextDocumentExtractor downloads and decodes supported text documents", async () => {
  const calls = [];
  const extractor = new TelegramTextDocumentExtractor({
    botToken: "test-token",
    baseUrl: "https://telegram.test",
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes("/getFile")) {
        return {
          ok: true,
          async json() {
            return { result: { file_path: "documents/material.md" } };
          },
        };
      }

      return {
        ok: true,
        async arrayBuffer() {
          return new TextEncoder()
            .encode("Past Simple warm-up\nAsk about yesterday.")
            .buffer;
        },
      };
    },
  });

  const result = await extractor.extractTelegramDocument({
    fileId: "doc-file",
    fileName: "material.md",
    mimeType: "text/markdown",
    fileSize: 120,
  });

  assert.equal(result.ok, true);
  assert.equal(result.title, "material");
  assert.match(result.text, /Past Simple/);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /getFile/);
  assert.match(calls[1], /documents\/material\.md/);
});

test("TelegramTextDocumentExtractor rejects unsupported document types", async () => {
  const extractor = new TelegramTextDocumentExtractor({
    botToken: "test-token",
    fetchImpl: async () => {
      throw new Error("fetch should not be called for unsupported document");
    },
  });

  const result = await extractor.extractTelegramDocument({
    fileId: "pdf-file",
    fileName: "material.pdf",
    mimeType: "application/pdf",
    fileSize: 120,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported_document_type");
});
