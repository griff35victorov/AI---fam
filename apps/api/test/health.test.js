import assert from "node:assert/strict";
import test from "node:test";

import { createDeepHealthResponse, createHealthResponse } from "../src/health.js";

test("health response reports ok and core subsystem names", () => {
  const response = createHealthResponse();

  assert.equal(response.status, "ok");
  assert.deepEqual(response.subsystems, ["api", "database", "ai_provider", "worker"]);
});

test("health response can expose deployment version without secrets", () => {
  const response = createHealthResponse({
    version: {
      commitSha: "46e1f2f235c4aeaea2eb367de1873b8cf234851b",
      buildTime: "2026-07-28T10:00:00.000Z",
    },
  });

  assert.equal(response.version.commitSha, "46e1f2f235c4aeaea2eb367de1873b8cf234851b");
  assert.equal(response.version.shortCommitSha, "46e1f2f");
  assert.doesNotMatch(JSON.stringify(response), /token|secret|key/i);
});

test("deep health reports repository and provider readiness", async () => {
  const response = await createDeepHealthResponse({
    version: { commitSha: "46e1f2f235c4aeaea2eb367de1873b8cf234851b" },
    repositories: {
      conversations: { listRecentForActor: async () => [] },
      memories: { listForActor: async () => [] },
      materials: { search: async () => [] },
      jobs: { listRecent: async () => [] },
      auditLogs: { listRecent: async () => [] },
    },
    capabilities: {
      aiProviderConfigured: true,
      kimiConfigured: true,
      timewebConfigured: true,
      telegramConfigured: true,
      googleCalendarConfigured: false,
      googleGmailConfigured: false,
      voiceTranscriptionConfigured: false,
      imageOcrConfigured: true,
      telegramRuntime: {
        webhookIngressMode: "relay",
        replyMode: "webhook_response",
        pollingEnabled: false,
        pollingClearWebhookEnabled: false,
        updateQueueEnabled: true,
        visibleAcceptedAckEnabled: false,
        relayConfigured: true,
        backgroundSendMode: "relay",
        directBackgroundSendAllowed: false,
        token: "must-not-leak",
      },
    },
  });

  assert.equal(response.status, "degraded");
  assert.equal(response.version.shortCommitSha, "46e1f2f");
  assert.equal(response.checks.database.status, "ok");
  assert.equal(response.checks.ai_provider.status, "ok");
  assert.equal(response.checks.google_calendar.status, "not_configured");
  assert.equal(response.checks.ocr.status, "ok");
  assert.deepEqual(response.checks.telegram.runtime, {
    webhookIngressMode: "relay",
    replyMode: "webhook_response",
    pollingEnabled: false,
    pollingClearWebhookEnabled: false,
    updateQueueEnabled: true,
    visibleAcceptedAckEnabled: false,
    relayConfigured: true,
    backgroundSendMode: "relay",
    directBackgroundSendAllowed: false,
  });
  assert.doesNotMatch(JSON.stringify(response), /token|secret|sk-|must-not-leak/i);
});
