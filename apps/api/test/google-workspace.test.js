import assert from "node:assert/strict";
import test from "node:test";

import {
  GoogleCalendarProvider,
  GoogleGmailProvider,
  GoogleOAuthClient,
  createGoogleWorkspaceProviders,
} from "../src/google-workspace.js";
import { createCapabilityRegistry } from "../src/capabilities.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test("GoogleOAuthClient refreshes and caches access tokens", async () => {
  const calls = [];
  const client = new GoogleOAuthClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ access_token: "access-token", expires_in: 3600 });
    },
    clock: () => new Date("2026-07-23T09:00:00.000Z"),
  });

  assert.equal(await client.accessToken(), "access-token");
  assert.equal(await client.accessToken(), "access-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].options.method, "POST");

  const body = new URLSearchParams(String(calls[0].options.body));
  assert.equal(body.get("client_id"), "client-id");
  assert.equal(body.get("client_secret"), "client-secret");
  assert.equal(body.get("refresh_token"), "refresh-token");
  assert.equal(body.get("grant_type"), "refresh_token");
});

test("GoogleCalendarProvider lists owner calendar events for the whole requested local day", async () => {
  const calls = [];
  const provider = new GoogleCalendarProvider({
    oauthClient: { accessToken: async () => "calendar-access" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        items: [
          {
            summary: "Dentist",
            location: "Clinic",
            start: { dateTime: "2026-07-24T09:30:00+03:00" },
          },
        ],
      });
    },
    clock: () => new Date("2026-07-23T10:15:00.000Z"),
    defaultTimeZone: "Europe/Moscow",
    maxEvents: 7,
  });

  const result = await provider.listEvents({
    actor: { role: "owner" },
    text: "Что у меня в календаре завтра?",
  });

  assert.equal(result.source, "calendar_scheduling");
  assert.match(result.text, /Dentist/);
  assert.match(result.text, /Clinic/);
  assert.match(result.text, /Google Calendar/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, "Bearer calendar-access");

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(url.searchParams.get("singleEvents"), "true");
  assert.equal(url.searchParams.get("orderBy"), "startTime");
  assert.equal(url.searchParams.get("maxResults"), "7");
  assert.equal(url.searchParams.get("timeZone"), "Europe/Moscow");
  assert.equal(url.searchParams.get("timeMin"), "2026-07-23T21:00:00.000Z");
  assert.equal(url.searchParams.get("timeMax"), "2026-07-24T21:00:00.000Z");
});

test("GoogleGmailProvider lists Gmail metadata with safe readonly query", async () => {
  const calls = [];
  const provider = new GoogleGmailProvider({
    oauthClient: { accessToken: async () => "gmail-access" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);

      if (parsed.pathname.endsWith("/messages") && !parsed.pathname.includes("/messages/")) {
        return jsonResponse({ messages: [{ id: "m1" }, { id: "m2" }] });
      }

      if (parsed.pathname.endsWith("/messages/m1")) {
        return jsonResponse({
          id: "m1",
          snippet: "First snippet",
          payload: {
            headers: [
              { name: "From", value: "Teacher <teacher@example.com>" },
              { name: "Subject", value: "Lesson plan" },
              { name: "Date", value: "Thu, 23 Jul 2026 10:00:00 +0300" },
            ],
          },
        });
      }

      return jsonResponse({
        id: "m2",
        snippet: "Second snippet",
        payload: {
          headers: [
            { name: "From", value: "School <school@example.com>" },
            { name: "Subject", value: "Meeting" },
          ],
        },
      });
    },
    maxMessages: 2,
  });

  const result = await provider.listMessages({
    actor: { role: "owner" },
    text: "Покажи непрочитанные письма",
  });

  assert.equal(result.source, "email_triage");
  assert.match(result.text, /Lesson plan/);
  assert.match(result.text, /Meeting/);
  assert.match(result.text, /Gmail/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.authorization, "Bearer gmail-access");

  const listUrl = new URL(calls[0].url);
  assert.equal(listUrl.searchParams.get("q"), "is:unread");
  assert.equal(listUrl.searchParams.get("maxResults"), "2");
});

test("Google Workspace providers deny non-owner roles before calling Google", async () => {
  const calls = [];
  const oauthClient = {
    async accessToken() {
      throw new Error("token should not be requested for denied role");
    },
  };
  const fetchImpl = async (...args) => {
    calls.push(args);
    throw new Error("fetch should not be called for denied role");
  };
  const calendarProvider = new GoogleCalendarProvider({ oauthClient, fetchImpl });
  const emailProvider = new GoogleGmailProvider({ oauthClient, fetchImpl });

  const calendar = await calendarProvider.listEvents({
    actor: { role: "family_child" },
    text: "календарь завтра",
  });
  const email = await emailProvider.listMessages({
    actor: { role: "family_child" },
    text: "почта",
  });

  assert.equal(calendar.metadata.authorized, false);
  assert.equal(email.metadata.authorized, false);
  assert.equal(calls.length, 0);
});

test("createGoogleWorkspaceProviders respects env toggles", () => {
  const enabled = createGoogleWorkspaceProviders({
    env: {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
    },
  });
  assert.ok(enabled.calendarProvider);
  assert.ok(enabled.emailProvider);

  const calendarOnly = createGoogleWorkspaceProviders({
    env: {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      GOOGLE_GMAIL_ENABLED: "false",
    },
  });
  assert.ok(calendarOnly.calendarProvider);
  assert.equal(calendarOnly.emailProvider, undefined);

  const missing = createGoogleWorkspaceProviders({
    env: {
      GOOGLE_CLIENT_ID: "client-id",
    },
  });
  assert.deepEqual(missing, {});
});

test("daily briefing includes connected calendar and email provider results", async () => {
  const capabilityRegistry = createCapabilityRegistry({
    fetchImpl: async () => {
      throw new Error("weather is offline in this test");
    },
    calendarProvider: {
      async listEvents(args) {
        assert.equal(args.actor.role, "owner");
        assert.equal(args.limit, 5);
        return { text: "Календарь: test event", source: "calendar_scheduling" };
      },
    },
    emailProvider: {
      async listMessages(args) {
        assert.equal(args.actor.role, "owner");
        assert.equal(args.limit, 5);
        return { text: "Почта Gmail: test message", source: "email_triage" };
      },
    },
  });

  const result = await capabilityRegistry.run("daily_briefing", {
    actor: { role: "owner" },
    workspaceId: "workspace-family",
    text: "утренняя сводка",
  });

  assert.equal(result.source, "daily_briefing");
  assert.match(result.text, /Календарь: test event/);
  assert.match(result.text, /Почта Gmail: test message/);
});
