const defaultGoogleTokenUrl = "https://oauth2.googleapis.com/token";
const defaultGoogleCalendarBaseUrl = "https://www.googleapis.com/calendar/v3";
const defaultGoogleGmailBaseUrl = "https://gmail.googleapis.com/gmail/v1";
const defaultTimeoutMs = 8000;

function envValue(value) {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback = []) {
  const text = envValue(value);
  if (!text) return fallback;
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response) {
  if (typeof response.text === "function") {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }

  return "";
}

async function readJsonResponse(response, context) {
  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(`${context} failed with status ${response.status}: ${body.slice(0, 240)}`);
  }

  return response.json();
}

function normalizeAllowedRoles(allowedRoles) {
  return new Set((allowedRoles?.length ? allowedRoles : ["owner"]).map((role) => String(role)));
}

function roleAllowed(actor, allowedRoles) {
  return allowedRoles.has(String(actor?.role ?? ""));
}

function trimLine(text, maxLength = 160) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour) % 24,
    Number(values.minute),
    Number(values.second),
  );

  return asUtc - date.getTime();
}

function localDateTimeToUtc(parts, timeZone) {
  const guess = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    ),
  );
  const firstOffset = timeZoneOffsetMs(guess, timeZone);
  const firstUtc = new Date(guess.getTime() - firstOffset);
  const secondOffset = timeZoneOffsetMs(firstUtc, timeZone);
  return new Date(guess.getTime() - secondOffset);
}

function localDayRange(label, now, timeZone, offsetDays) {
  const today = localDateParts(now, timeZone);
  const startDay = addLocalDays(today, offsetDays);
  const nextDay = addLocalDays(today, offsetDays + 1);

  return {
    label,
    timeMin: localDateTimeToUtc(startDay, timeZone),
    timeMax: localDateTimeToUtc(nextDay, timeZone),
  };
}

function parseCalendarRange(text, now = new Date(), timeZone = "Europe/Moscow") {
  const normalized = String(text ?? "").toLowerCase();
  const dayMs = 24 * 60 * 60 * 1000;

  if (/(?:завтра|tomorrow)/i.test(normalized)) {
    return localDayRange("завтра", now, timeZone, 1);
  }

  if (/(?:сегодня|today)/i.test(normalized)) {
    return {
      label: "сегодня",
      timeMin: now,
      timeMax: localDayRange("сегодня", now, timeZone, 0).timeMax,
    };
  }

  if (/(?:недел|week)/i.test(normalized)) {
    return {
      label: "на ближайшую неделю",
      timeMin: now,
      timeMax: new Date(now.getTime() + 7 * dayMs),
    };
  }

  return {
    label: "на ближайшие 7 дней",
    timeMin: now,
    timeMax: new Date(now.getTime() + 7 * dayMs),
  };
}

function formatEventStart(start, timeZone) {
  const value = start?.dateTime ?? start?.date;
  if (!value) return "без времени";

  if (start?.date && !start?.dateTime) {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return value;
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function calendarEventLine(event, timeZone) {
  const title = trimLine(event.summary || "Без названия", 100);
  const start = formatEventStart(event.start, timeZone);
  const location = event.location ? `, ${trimLine(event.location, 80)}` : "";
  return `- ${start}: ${title}${location}`;
}

function gmailHeader(message, headerName) {
  const headers = message?.payload?.headers ?? [];
  const header = headers.find(
    (item) => String(item.name ?? "").toLowerCase() === headerName.toLowerCase(),
  );
  return header?.value ?? "";
}

function buildGmailQuery(text, fallbackQuery) {
  const normalized = String(text ?? "").toLowerCase();
  const terms = [];

  if (/(?:непроч|unread)/i.test(normalized)) terms.push("is:unread");
  if (/(?:важн|important)/i.test(normalized)) terms.push("is:important");
  if (/(?:сегодня|today)/i.test(normalized)) terms.push("newer_than:1d");

  return terms.length > 0 ? terms.join(" ") : fallbackQuery;
}

function emailMessageLine(message) {
  const from = trimLine(gmailHeader(message, "From") || "неизвестный отправитель", 80);
  const subject = trimLine(gmailHeader(message, "Subject") || "без темы", 120);
  const date = trimLine(gmailHeader(message, "Date"), 60);
  const snippet = trimLine(message.snippet, 140);
  const suffix = snippet ? `: ${snippet}` : "";
  const datePart = date ? ` (${date})` : "";
  return `- ${from}${datePart}: ${subject}${suffix}`;
}

export class GoogleOAuthClient {
  constructor({
    clientId,
    clientSecret,
    refreshToken,
    fetchImpl = fetch,
    tokenUrl = defaultGoogleTokenUrl,
    timeoutMs = defaultTimeoutMs,
    clock = () => new Date(),
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.fetchImpl = fetchImpl;
    this.tokenUrl = tokenUrl;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.cachedToken = null;
  }

  async accessToken() {
    if (!this.clientId || !this.clientSecret || !this.refreshToken) {
      throw new Error("Google OAuth credentials are not configured");
    }

    const nowMs = this.clock().getTime();
    if (this.cachedToken && this.cachedToken.expiresAtMs - nowMs > 60_000) {
      return this.cachedToken.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(this.fetchImpl, this.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      timeoutMs: this.timeoutMs,
    });
    const payload = await readJsonResponse(response, "Google OAuth token refresh");
    if (!payload.access_token) {
      throw new Error("Google OAuth token refresh returned no access_token");
    }

    const expiresInMs = Number(payload.expires_in ?? 3600) * 1000;
    this.cachedToken = {
      accessToken: payload.access_token,
      expiresAtMs: nowMs + expiresInMs,
    };
    return this.cachedToken.accessToken;
  }
}

export class GoogleCalendarProvider {
  constructor({
    oauthClient,
    fetchImpl = fetch,
    baseUrl = defaultGoogleCalendarBaseUrl,
    calendarId = "primary",
    defaultTimeZone = "Europe/Moscow",
    maxEvents = 10,
    timeoutMs = defaultTimeoutMs,
    allowedRoles = ["owner"],
    clock = () => new Date(),
  } = {}) {
    this.oauthClient = oauthClient;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.calendarId = calendarId;
    this.defaultTimeZone = defaultTimeZone;
    this.maxEvents = maxEvents;
    this.timeoutMs = timeoutMs;
    this.allowedRoles = normalizeAllowedRoles(allowedRoles);
    this.clock = clock;
  }

  async listEvents(args = {}) {
    if (!roleAllowed(args.actor, this.allowedRoles)) {
      return {
        text: "Календарь подключен только для владельца. Для семейного доступа нужно отдельное разрешение.",
        source: "calendar_scheduling",
        metadata: { authorized: false },
      };
    }

    const range = parseCalendarRange(args.text, args.now ?? this.clock(), this.defaultTimeZone);
    const token = await this.oauthClient.accessToken();
    const url = new URL(`${this.baseUrl}/calendars/${encodeURIComponent(this.calendarId)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", String(args.limit ?? this.maxEvents));
    url.searchParams.set("timeMin", range.timeMin.toISOString());
    url.searchParams.set("timeMax", range.timeMax.toISOString());
    url.searchParams.set("timeZone", this.defaultTimeZone);

    const response = await fetchWithTimeout(this.fetchImpl, url.toString(), {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: this.timeoutMs,
    });
    const payload = await readJsonResponse(response, "Google Calendar events");
    const events = Array.isArray(payload.items) ? payload.items : [];

    return {
      text:
        events.length > 0
          ? [
              `Календарь ${range.label}:`,
              ...events.map((event) => calendarEventLine(event, this.defaultTimeZone)),
              "Источник: Google Calendar.",
            ].join("\n")
          : `Календарь ${range.label}: событий не найдено.\nИсточник: Google Calendar.`,
      source: "calendar_scheduling",
      metadata: {
        calendarId: this.calendarId,
        eventCount: events.length,
        timeMin: range.timeMin.toISOString(),
        timeMax: range.timeMax.toISOString(),
      },
    };
  }
}

export class GoogleGmailProvider {
  constructor({
    oauthClient,
    fetchImpl = fetch,
    baseUrl = defaultGoogleGmailBaseUrl,
    userId = "me",
    defaultQuery = "newer_than:7d",
    maxMessages = 5,
    timeoutMs = defaultTimeoutMs,
    allowedRoles = ["owner"],
  } = {}) {
    this.oauthClient = oauthClient;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.userId = userId;
    this.defaultQuery = defaultQuery;
    this.maxMessages = maxMessages;
    this.timeoutMs = timeoutMs;
    this.allowedRoles = normalizeAllowedRoles(allowedRoles);
  }

  async listMessages(args = {}) {
    if (!roleAllowed(args.actor, this.allowedRoles)) {
      return {
        text: "Почта подключена только для владельца. Для семейного доступа нужно отдельное разрешение.",
        source: "email_triage",
        metadata: { authorized: false },
      };
    }

    const query = buildGmailQuery(args.text, this.defaultQuery);
    const limit = args.limit ?? this.maxMessages;
    const token = await this.oauthClient.accessToken();
    const headers = { authorization: `Bearer ${token}` };
    const listUrl = new URL(`${this.baseUrl}/users/${encodeURIComponent(this.userId)}/messages`);
    listUrl.searchParams.set("q", query);
    listUrl.searchParams.set("maxResults", String(limit));

    const listResponse = await fetchWithTimeout(this.fetchImpl, listUrl.toString(), {
      headers,
      timeoutMs: this.timeoutMs,
    });
    const listPayload = await readJsonResponse(listResponse, "Gmail message list");
    const ids = (Array.isArray(listPayload.messages) ? listPayload.messages : [])
      .map((message) => message.id)
      .filter(Boolean)
      .slice(0, limit);

    if (ids.length === 0) {
      return {
        text: `Почта Gmail: по запросу "${query}" писем не найдено.\nИсточник: Gmail.`,
        source: "email_triage",
        metadata: { query, messageCount: 0 },
      };
    }

    const messages = [];
    for (const id of ids) {
      const messageUrl = new URL(
        `${this.baseUrl}/users/${encodeURIComponent(this.userId)}/messages/${encodeURIComponent(id)}`,
      );
      messageUrl.searchParams.set("format", "metadata");
      messageUrl.searchParams.append("metadataHeaders", "From");
      messageUrl.searchParams.append("metadataHeaders", "Subject");
      messageUrl.searchParams.append("metadataHeaders", "Date");

      const messageResponse = await fetchWithTimeout(this.fetchImpl, messageUrl.toString(), {
        headers,
        timeoutMs: this.timeoutMs,
      });
      messages.push(await readJsonResponse(messageResponse, "Gmail message metadata"));
    }

    return {
      text: [
        `Почта Gmail: последние письма по запросу "${query}":`,
        ...messages.map(emailMessageLine),
        "Источник: Gmail.",
      ].join("\n"),
      source: "email_triage",
      metadata: {
        query,
        messageCount: messages.length,
      },
    };
  }
}

export function createGoogleWorkspaceProviders({
  env = process.env,
  fetchImpl = fetch,
  clock = () => new Date(),
} = {}) {
  const clientId = envValue(env.GOOGLE_CLIENT_ID);
  const clientSecret = envValue(env.GOOGLE_CLIENT_SECRET);
  const refreshToken = envValue(env.GOOGLE_REFRESH_TOKEN);
  if (!clientId || !clientSecret || !refreshToken) {
    return {};
  }

  const timeoutMs = parseNumber(env.GOOGLE_API_TIMEOUT_MS, defaultTimeoutMs);
  const allowedRoles = parseCsv(env.GOOGLE_WORKSPACE_ALLOWED_ROLES, ["owner"]);
  const oauthClient = new GoogleOAuthClient({
    clientId,
    clientSecret,
    refreshToken,
    fetchImpl,
    timeoutMs,
    clock,
  });

  return {
    calendarProvider: parseBoolean(env.GOOGLE_CALENDAR_ENABLED, true)
      ? new GoogleCalendarProvider({
          oauthClient,
          fetchImpl,
          calendarId: envValue(env.GOOGLE_CALENDAR_ID) ?? "primary",
          defaultTimeZone: envValue(env.APP_DEFAULT_TIME_ZONE) ?? "Europe/Moscow",
          maxEvents: parseNumber(env.GOOGLE_CALENDAR_MAX_EVENTS, 10),
          timeoutMs,
          allowedRoles,
          clock,
        })
      : undefined,
    emailProvider: parseBoolean(env.GOOGLE_GMAIL_ENABLED, true)
      ? new GoogleGmailProvider({
          oauthClient,
          fetchImpl,
          userId: envValue(env.GOOGLE_GMAIL_USER_ID) ?? "me",
          defaultQuery: envValue(env.GOOGLE_GMAIL_DEFAULT_QUERY) ?? "newer_than:7d",
          maxMessages: parseNumber(env.GOOGLE_GMAIL_MAX_MESSAGES, 5),
          timeoutMs,
          allowedRoles,
        })
      : undefined,
  };
}
