import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

export const capabilityCatalog = [
  {
    id: "weather_forecast",
    title: "Weather forecast",
    category: "P0",
    description: "Open-Meteo forecast by city, including weekend weather.",
    access: "free_network",
  },
  {
    id: "weather_fallback_wttr",
    title: "Weather fallback",
    category: "P0",
    description: "Backup forecast through wttr.in when Open-Meteo is unavailable.",
    access: "free_network",
  },
  {
    id: "web_fetch_url",
    title: "Read a URL",
    category: "P0",
    description: "Fetches and extracts text from a specific public URL.",
    access: "free_network",
  },
  {
    id: "web_current_data",
    title: "Current web data",
    category: "P0",
    description: "Searches current web data. Requires a connected web search provider.",
    access: "provider",
    missingAccess: "Нужен бесплатный или платный web-search/fetch провайдер: Fetch MCP, Firecrawl, Playwright MCP или browser-use.",
  },
  {
    id: "browser_automation",
    title: "Browser automation",
    category: "P0",
    description: "Uses a browser tool for sites that require interaction.",
    access: "provider",
    missingAccess: "Нужен Playwright MCP, browser-use или другой браузерный исполнитель.",
  },
  {
    id: "time_location_context",
    title: "Time and location context",
    category: "P0",
    description: "Understands today, tomorrow, weekends, time zones and default Moscow context.",
    access: "local",
  },
  {
    id: "calendar_scheduling",
    title: "Calendar scheduling",
    category: "P1",
    description: "Reads and writes calendar events.",
    access: "oauth",
    missingAccess: "Нужен доступ к Google Calendar, CalDAV или Microsoft Calendar.",
  },
  {
    id: "email_triage",
    title: "Email triage",
    category: "P1",
    description: "Reads, summarizes and drafts email.",
    access: "oauth",
    missingAccess: "Нужен доступ к Gmail, Outlook или IMAP.",
  },
  {
    id: "telegram_ops",
    title: "Telegram bot operations",
    category: "P1",
    description: "Receives Telegram messages, routes users and sends replies.",
    access: "configured",
  },
  {
    id: "tasks_reminders",
    title: "Tasks and reminders",
    category: "P1",
    description: "Creates reminders, tasks and follow-ups.",
    access: "provider",
    missingAccess: "Нужен Google Tasks, CalDAV reminders, локальный планировщик или другой исполнитель напоминаний.",
  },
  {
    id: "contacts_memory",
    title: "Contacts memory",
    category: "P1",
    description: "Works with contacts, birthdays and people metadata.",
    access: "oauth",
    missingAccess: "Нужен доступ к Google Contacts, Microsoft Contacts или отдельной базе контактов.",
  },
  {
    id: "daily_briefing",
    title: "Daily briefing",
    category: "P1",
    description: "Builds daily summaries from weather, calendar, tasks and email.",
    access: "provider",
    missingAccess: "Нужны хотя бы календарь/задачи/почта, иначе ежедневная сводка будет неполной.",
  },
  {
    id: "docs_drive",
    title: "Docs and Drive",
    category: "P2",
    description: "Reads and manages Google Drive, Docs, Sheets, Slides and uploaded files.",
    access: "oauth",
    missingAccess: "Нужен доступ к Google Drive/Docs/Sheets/Slides или файловому хранилищу.",
  },
  {
    id: "travel_local",
    title: "Travel and local lookup",
    category: "P2",
    description: "Looks up public addresses and coordinates through OpenStreetMap/Nominatim.",
    access: "free_network",
  },
  {
    id: "voice_input",
    title: "Telegram voice input",
    category: "P2",
    description: "Transcribes Telegram voice messages.",
    access: "configured",
    missingAccess: "Нужен локальный Vosk или внешний STT endpoint.",
  },
  {
    id: "ocr",
    title: "OCR",
    category: "P2",
    description: "Recognizes text from images and scans.",
    access: "provider",
    missingAccess: "Нужен OCR исполнитель: Tesseract, Google Vision, OCR MCP или другой endpoint.",
  },
  {
    id: "tts",
    title: "Text to speech",
    category: "P2",
    description: "Creates voice replies.",
    access: "provider",
    missingAccess: "Нужен TTS endpoint или локальный движок озвучивания.",
  },
  {
    id: "automation",
    title: "Automation",
    category: "P2",
    description: "Runs scheduled workflows and webhooks.",
    access: "provider",
    missingAccess: "Нужен локальный планировщик, n8n, Activepieces, Make или webhooks.",
  },
  {
    id: "shopping_orders",
    title: "Shopping and orders",
    category: "P2",
    description: "Searches products, compares prices and tracks orders.",
    access: "provider",
    missingAccess: "Нужен web-search/browser provider или доступ к маркетплейсам и личным кабинетам заказов.",
  },
  {
    id: "finance_personal",
    title: "Personal finance",
    category: "P2",
    description: "Tracks expenses, bills, subscriptions and personal budget.",
    access: "provider",
    missingAccess: "Нужен источник финансовых данных или отдельная база расходов.",
  },
  {
    id: "meeting_briefing",
    title: "Meeting briefing",
    category: "P2",
    description: "Prepares agendas, context and follow-up notes for meetings.",
    access: "provider",
    missingAccess: "Нужны календарь, почта, документы или база встреч.",
  },
  {
    id: "materials_rag",
    title: "Teacher materials library",
    category: "core",
    description: "Uses the internal PostgreSQL material chunks.",
    access: "configured",
  },
  {
    id: "memory_agent",
    title: "Long-term memory",
    category: "core",
    description: "Stores safe user facts, preferences and teaching style.",
    access: "configured",
  },
  {
    id: "fallback_agent",
    title: "No-dead-end fallback",
    category: "core",
    description: "Explains which exact tool or access is missing instead of sending the user away.",
    access: "local",
  },
];

const capabilityById = new Map(capabilityCatalog.map((capability) => [capability.id, capability]));

const cityAliases = new Map([
  ["москве", "Москва"],
  ["москва", "Москва"],
  ["moscow", "Moscow"],
  ["санкт-петербурге", "Санкт-Петербург"],
  ["питере", "Санкт-Петербург"],
  ["спб", "Санкт-Петербург"],
]);

const timezoneAliases = new Map([
  ["москва", "Europe/Moscow"],
  ["москве", "Europe/Moscow"],
  ["moscow", "Europe/Moscow"],
  ["санкт-петербург", "Europe/Moscow"],
  ["санкт-петербурге", "Europe/Moscow"],
  ["питер", "Europe/Moscow"],
  ["питере", "Europe/Moscow"],
  ["спб", "Europe/Moscow"],
]);

const weatherCodeLabels = new Map([
  [0, "ясно"],
  [1, "в основном ясно"],
  [2, "переменная облачность"],
  [3, "пасмурно"],
  [45, "туман"],
  [48, "изморозь и туман"],
  [51, "легкая морось"],
  [53, "морось"],
  [55, "сильная морось"],
  [61, "небольшой дождь"],
  [63, "дождь"],
  [65, "сильный дождь"],
  [71, "небольшой снег"],
  [73, "снег"],
  [75, "сильный снег"],
  [80, "небольшие ливни"],
  [81, "ливни"],
  [82, "сильные ливни"],
  [95, "гроза"],
  [96, "гроза с градом"],
  [99, "сильная гроза с градом"],
]);

export function createCapabilityRegistry({
  fetchImpl = fetch,
  dnsLookup = lookup,
  weatherTimeoutMs = 6000,
  voiceTranscriber,
  webSearch,
  browserAutomation,
  calendarProvider,
  emailProvider,
  tasksProvider,
  contactsProvider,
  docsProvider,
  ocrProvider,
  ttsProvider,
  automationProvider,
  shoppingProvider,
  financeProvider,
  meetingProvider,
  materialsRepositoryAvailable = true,
  telegramConfigured = true,
  clock = () => new Date(),
  defaultLocation = "Москва",
  defaultTimeZone = "Europe/Moscow",
} = {}) {
  const deps = {
    fetchImpl,
    voiceTranscriber,
    webSearch,
    browserAutomation,
    calendarProvider,
    emailProvider,
    tasksProvider,
    contactsProvider,
    docsProvider,
    ocrProvider,
    ttsProvider,
    automationProvider,
    shoppingProvider,
    financeProvider,
    meetingProvider,
    materialsRepositoryAvailable,
    telegramConfigured,
  };

  return {
    list() {
      return capabilityCatalog.map((capability) => ({
        ...capability,
        ...capabilityState(capability.id, deps),
      }));
    },

    has(capabilityId) {
      return capabilityState(capabilityId, deps).available;
    },

    describe(capabilityId) {
      const capability = capabilityById.get(capabilityId);
      if (!capability) return null;
      return {
        ...capability,
        ...capabilityState(capabilityId, deps),
      };
    },

    async run(capabilityId, args = {}) {
      if (capabilityId === "weather_forecast") {
        return fetchWeatherForecast({ ...args, fetchImpl, timeoutMs: weatherTimeoutMs });
      }

      if (capabilityId === "weather_fallback_wttr") {
        return fetchWttrWeatherForecast({ ...args, fetchImpl, timeoutMs: weatherTimeoutMs });
      }

      if (capabilityId === "web_fetch_url") {
        return fetchWebPageSummary({
          ...args,
          fetchImpl,
          dnsLookup,
          timeoutMs: args.timeoutMs ?? 7000,
        });
      }

      if (capabilityId === "time_location_context") {
        return buildTimeLocationContext({
          ...args,
          now: clock(),
          defaultLocation,
          defaultTimeZone,
        });
      }

      if (capabilityId === "travel_local") {
        return fetchLocationLookup({ ...args, fetchImpl, timeoutMs: args.timeoutMs ?? 7000 });
      }

      if (capabilityId === "voice_input" && voiceTranscriber) {
        return voiceTranscriber.transcribeTelegramVoice(args);
      }

      if (capabilityId === "web_current_data" && webSearch) {
        return webSearch.search(args);
      }

      if (capabilityId === "browser_automation" && browserAutomation) {
        return browserAutomation.run(args);
      }

      throw new Error(`Capability is not available: ${capabilityId}`);
    },
  };
}

function capabilityState(capabilityId, deps) {
  const available = capabilityAvailable(capabilityId, deps);
  const capability = capabilityById.get(capabilityId);
  if (!capability) {
    return {
      available: false,
      status: "unknown",
      statusText: "неизвестный инструмент",
    };
  }

  if (available) {
    return {
      available: true,
      status: "connected",
      statusText: "подключен",
    };
  }

  const needsAccess = capability.access === "oauth" || capability.access === "provider";
  return {
    available: false,
    status: needsAccess ? "needs_access" : "not_configured",
    statusText: needsAccess ? "нужен доступ" : "не настроен",
  };
}

function capabilityAvailable(capabilityId, deps) {
  if (capabilityId === "weather_forecast") return Boolean(deps.fetchImpl);
  if (capabilityId === "weather_fallback_wttr") return Boolean(deps.fetchImpl);
  if (capabilityId === "web_fetch_url") return Boolean(deps.fetchImpl);
  if (capabilityId === "time_location_context") return true;
  if (capabilityId === "travel_local") return Boolean(deps.fetchImpl);
  if (capabilityId === "voice_input") return Boolean(deps.voiceTranscriber);
  if (capabilityId === "web_current_data") return Boolean(deps.webSearch);
  if (capabilityId === "browser_automation") return Boolean(deps.browserAutomation);
  if (capabilityId === "calendar_scheduling") return Boolean(deps.calendarProvider);
  if (capabilityId === "email_triage") return Boolean(deps.emailProvider);
  if (capabilityId === "telegram_ops") return Boolean(deps.telegramConfigured);
  if (capabilityId === "tasks_reminders") return Boolean(deps.tasksProvider);
  if (capabilityId === "contacts_memory") return Boolean(deps.contactsProvider);
  if (capabilityId === "daily_briefing") {
    return Boolean(deps.calendarProvider || deps.emailProvider || deps.tasksProvider);
  }
  if (capabilityId === "docs_drive") return Boolean(deps.docsProvider);
  if (capabilityId === "ocr") return Boolean(deps.ocrProvider);
  if (capabilityId === "tts") return Boolean(deps.ttsProvider);
  if (capabilityId === "automation") return Boolean(deps.automationProvider);
  if (capabilityId === "shopping_orders") return Boolean(deps.shoppingProvider);
  if (capabilityId === "finance_personal") return Boolean(deps.financeProvider);
  if (capabilityId === "meeting_briefing") return Boolean(deps.meetingProvider);
  if (capabilityId === "materials_rag") return Boolean(deps.materialsRepositoryAvailable);
  if (capabilityId === "memory_agent") return true;
  if (capabilityId === "fallback_agent") return true;
  return false;
}

export function isWeatherRequest(text) {
  const normalized = String(text ?? "").toLowerCase();
  return /(?:погода|температур|дожд|снег|ветер|weather|forecast)/i.test(normalized);
}

export function parseWeatherRequest(text) {
  const normalized = String(text ?? "").trim();
  const lower = normalized.toLowerCase();
  let location = null;

  for (const [alias, city] of cityAliases.entries()) {
    if (lower.includes(alias)) {
      location = city;
      break;
    }
  }

  if (!location) {
    const locationMatch =
      normalized.match(/(?:в|во|для)\s+([A-Za-zА-Яа-яЁё -]{3,40})(?:\s+(?:на|завтра|сегодня|будет|ожидается)|[?.!,]|$)/i) ??
      normalized.match(/weather\s+in\s+([A-Za-zА-Яа-яЁё -]{3,40})/i);
    location = locationMatch?.[1]?.trim() ?? null;
  }

  return {
    location: location ?? "Москва",
    target: lower.includes("выходн") || lower.includes("weekend") ? "weekend" : "daily",
  };
}

export function extractUrls(text) {
  const matches = String(text ?? "").match(/\bhttps?:\/\/[^\s<>"')]+/gi) ?? [];
  return [...new Set(matches.map(cleanUrl).filter(Boolean))];
}

function cleanUrl(url) {
  const cleaned = String(url ?? "").replace(/[.,!?;:]+$/g, "");
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isWebFetchRequest(text) {
  return extractUrls(text).length > 0;
}

export function isTimeLocationRequest(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "/time" || normalized === "/date") return true;

  return /(?:который час|сколько времени|текущее время|какое сейчас время|какая дата|какой сегодня день|какое сегодня число|ближайшие выходные|когда выходные|time now|current time|today date|timezone)/i.test(normalized);
}

export function isTravelLocalRequest(text) {
  const normalized = String(text ?? "").toLowerCase();
  return /(?:координат|адрес|где находится|найди место|покажи место|карта|маршрут до|как доехать до|location|coordinates|address)/i.test(normalized);
}

export function parseLocationLookupRequest(text) {
  const normalized = String(text ?? "")
    .replace(/\bhttps?:\/\/[^\s<>"')]+/gi, "")
    .replace(/(?:найди|покажи|подскажи|какой|какие|где находится|координаты|адрес|маршрут до|как доехать до|location|coordinates|address|карта)/gi, " ")
    .replace(/[?!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    query: normalized,
  };
}

export function isCurrentDataRequest(text) {
  const normalized = String(text ?? "").toLowerCase();
  return /(?:актуальн|новост|курс|цена|стоимост|наличии|расписан|рейс|котировк|current|latest|price|schedule|available)/i.test(normalized);
}

export function detectRequiredCapability(text) {
  const normalized = String(text ?? "").toLowerCase();

  if (isWeatherRequest(text)) return "weather_forecast";
  if (isWebFetchRequest(text)) return "web_fetch_url";
  if (isTimeLocationRequest(text)) return "time_location_context";
  if (isTravelLocalRequest(text)) return "travel_local";

  if (/(?:календар|встреч[ауеи]|событи[ея]|добавь.*календар|calendar|event)/i.test(normalized)) {
    return "calendar_scheduling";
  }

  if (
    /(?:напомни|напоминан|todo|reminder|deadline|дедлайн)/i.test(normalized) ||
    /(?:добавь|создай|поставь|запиши)\s+(?:задач|todo)/i.test(normalized)
  ) {
    return "tasks_reminders";
  }

  if (/(?:почт|письм|gmail|outlook|email|e-mail|inbox)/i.test(normalized)) {
    return "email_triage";
  }

  if (/(?:google drive|гугл диск|документ|таблиц|презентац|docs|sheets|slides|pdf|docx|xlsx)/i.test(normalized)) {
    return "docs_drive";
  }

  if (/(?:контакт|день рождения|телефон|contacts?)/i.test(normalized)) {
    return "contacts_memory";
  }

  if (/(?:ежедневн.*сводк|утренн.*сводк|дайджест дня|daily briefing|morning briefing)/i.test(normalized)) {
    return "daily_briefing";
  }

  if (/(?:подготовь.*встреч|повестк[ауи]|agenda|meeting briefing|протокол встречи|follow-up)/i.test(normalized)) {
    return "meeting_briefing";
  }

  if (/(?:открой сайт|заполни форму|нажми|браузер|playwright|browser-use|browser automation)/i.test(normalized)) {
    return "browser_automation";
  }

  if (/(?:распознай.*(?:фото|картинк|скан)|текст с картинки|ocr|scan)/i.test(normalized)) {
    return "ocr";
  }

  if (/(?:озвучь|голосом ответь|tts|text to speech)/i.test(normalized)) {
    return "tts";
  }

  if (/(?:автоматизируй|webhook|cron|n8n|activepieces|make.com|автоматизация)/i.test(normalized)) {
    return "automation";
  }

  if (/(?:товар|купить|где купить|сравни цен|заказ|доставк|wildberries|ozon|маркетплейс|shopping|order tracking)/i.test(normalized)) {
    return "shopping_orders";
  }

  if (/(?:расход|бюджет|счет|счёт|платеж|платёж|подписк|финанс|finance|expense|subscription)/i.test(normalized)) {
    return "finance_personal";
  }

  if (isCurrentDataRequest(text)) return "web_current_data";
  return null;
}

export function buildCapabilitiesAnswer(registry) {
  const capabilities = registry?.list?.() ?? capabilityCatalog.map((item) => ({
    ...item,
    available: false,
    status: "not_configured",
    statusText: "не настроен",
  }));

  const connected = capabilities.filter((capability) => capability.available);
  const missing = capabilities.filter((capability) => !capability.available);

  return [
    "Инструменты оркестра:",
    "",
    "Подключены:",
    ...connected.map((capability) => `- ${capability.id}: ${capability.statusText}`),
    "",
    "Нужен доступ или провайдер:",
    ...missing.map((capability) => `- ${capability.id}: ${capability.statusText}`),
    "",
    "Правило без тупиков: если запрос требует инструмента, бот сначала пробует capability; если доступа нет, пишет, какой именно доступ нужен.",
  ].join("\n");
}

export function buildMissingCapabilityAnswer(capabilityId, text) {
  const capability = capabilityById.get(capabilityId) ?? capabilityById.get("web_current_data");
  const reason = capability?.missingAccess ?? "Нужно подключить этот источник к оркестру.";

  return [
    "Для этого запроса нужен инструмент, а не ответ по памяти.",
    `Нужный инструмент: ${capability?.id ?? capabilityId}.`,
    `Что нужно подключить: ${reason}`,
    "Я не буду отправлять вас проверять сайт или сервис вручную; после подключения доступа оркестр будет вызывать инструмент сам.",
  ].join("\n");
}

export function buildMissingCurrentDataCapabilityAnswer(text) {
  const capability = detectRequiredCapability(text) ?? "web_current_data";
  return buildMissingCapabilityAnswer(capability, text);
}

export async function fetchWeatherForecast({
  location,
  target = "daily",
  fetchImpl = fetch,
  timeoutMs = 6000,
  forecastDays = 10,
} = {}) {
  const city = String(location ?? "Москва").trim() || "Москва";
  const geocodeUrl =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}` +
    "&count=1&language=ru&format=json";
  const geocodeResponse = await fetchWithTimeout(fetchImpl, geocodeUrl, {
    timeoutMs,
  });
  if (!geocodeResponse.ok) {
    throw new Error(`Open-Meteo geocoding failed with ${geocodeResponse.status}`);
  }

  const geocode = await geocodeResponse.json();
  const place = geocode.results?.[0];
  if (!place) {
    return {
      text: `Не нашел город "${city}" в погодном справочнике. Уточните населенный пункт.`,
      source: "weather_forecast",
    };
  }

  const forecastUrl =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${place.latitude}&longitude=${place.longitude}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max" +
    `&forecast_days=${forecastDays}&timezone=auto`;
  const forecastResponse = await fetchWithTimeout(fetchImpl, forecastUrl, {
    timeoutMs,
  });
  if (!forecastResponse.ok) {
    throw new Error(`Open-Meteo forecast failed with ${forecastResponse.status}`);
  }

  const forecast = await forecastResponse.json();
  const days = dailyRows(forecast.daily);
  const selectedDays = target === "weekend" ? nextWeekendRows(days) : days.slice(0, 3);
  const placeLabel = [place.name, place.admin1, place.country]
    .filter(Boolean)
    .join(", ");

  return {
    text: formatWeatherAnswer({ placeLabel, days: selectedDays, target, sourceLabel: "Open-Meteo" }),
    source: "weather_forecast",
    metadata: {
      location: placeLabel,
      latitude: place.latitude,
      longitude: place.longitude,
    },
  };
}

export async function fetchWttrWeatherForecast({
  location,
  target = "daily",
  fetchImpl = fetch,
  timeoutMs = 6000,
} = {}) {
  const city = String(location ?? "Москва").trim() || "Москва";
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=ru`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    timeoutMs,
    headers: { "user-agent": "family-ai-orchestrator/0.1" },
  });
  if (!response.ok) {
    throw new Error(`wttr.in forecast failed with ${response.status}`);
  }

  const payload = await response.json();
  const current = payload.current_condition?.[0];
  const days = (payload.weather ?? []).slice(0, target === "weekend" ? 4 : 3).map((day) => ({
    date: day.date,
    weatherCode: Number(day.hourly?.[4]?.weatherCode ?? current?.weatherCode ?? 0),
    temperatureMax: Number(day.maxtempC),
    temperatureMin: Number(day.mintempC),
    precipitationProbability: Number(day.hourly?.[4]?.chanceofrain ?? 0),
    precipitationSum: Number(day.totalSnow_cm ?? 0),
    windSpeedMax: Number(day.hourly?.[4]?.windspeedKmph ?? 0),
  }));
  const selectedDays = target === "weekend" ? nextWeekendRows(days) : days.slice(0, 3);

  return {
    text: formatWeatherAnswer({
      placeLabel: city,
      days: selectedDays.length > 0 ? selectedDays : days.slice(0, 2),
      target,
      sourceLabel: "wttr.in",
    }),
    source: "weather_fallback_wttr",
    metadata: { location: city },
  };
}

export async function fetchWebPageSummary({
  url,
  text,
  fetchImpl = fetch,
  dnsLookup = lookup,
  timeoutMs = 7000,
} = {}) {
  const targetUrl = cleanUrl(url ?? extractUrls(text)[0]);
  if (!targetUrl) {
    return {
      text: "Не вижу корректную ссылку. Пришлите полный URL, начиная с http:// или https://.",
      source: "web_fetch_url",
    };
  }

  if (isBlockedFetchUrl(targetUrl)) {
    return buildBlockedFetchResult(targetUrl);
  }

  let response;
  try {
    response = await fetchPublicUrl(fetchImpl, targetUrl, {
      timeoutMs,
      dnsLookup,
    });
  } catch (error) {
    if (isBlockedFetchError(error)) {
      return buildBlockedFetchResult(targetUrl);
    }

    throw error;
  }
  if (!response.ok) {
    throw new Error(`URL fetch failed with ${response.status}`);
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  const body = await response.text();
  const title = extractHtmlTitle(body);
  const excerpt = extractReadableText(body, contentType).slice(0, 2400);

  return {
    text: [
      `Ссылка прочитана: ${targetUrl}`,
      title ? `Заголовок: ${title}` : null,
      "Фрагмент содержимого:",
      excerpt || "Текстовое содержимое не найдено.",
      `Источник: ${targetUrl}`,
    ].filter(Boolean).join("\n"),
    source: "web_fetch_url",
    metadata: {
      url: targetUrl,
      title,
      contentType,
      contentLength: body.length,
    },
  };
}

export function buildTimeLocationContext({
  text,
  now = new Date(),
  defaultLocation = "Москва",
  defaultTimeZone = "Europe/Moscow",
} = {}) {
  const lower = String(text ?? "").toLowerCase();
  const location = resolveLocation(lower, defaultLocation);
  const timeZone = resolveTimeZone(lower, defaultTimeZone);
  const current = new Date(now);
  const weekend = nextWeekendDates(current, timeZone);

  const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  });

  return {
    text: [
      `Сейчас в локации ${location}: ${timeFormatter.format(current)}, ${dateFormatter.format(current)}.`,
      `Часовой пояс: ${timeZone}.`,
      `Ближайшие выходные: ${dateFormatter.format(weekend.saturday)} и ${dateFormatter.format(weekend.sunday)}.`,
    ].join("\n"),
    source: "time_location_context",
    metadata: {
      location,
      timeZone,
      now: current.toISOString(),
    },
  };
}

export async function fetchLocationLookup({
  query,
  text,
  fetchImpl = fetch,
  timeoutMs = 7000,
} = {}) {
  const lookupQuery = String(query ?? parseLocationLookupRequest(text).query ?? "").trim();
  if (lookupQuery.length < 3) {
    return {
      text: "Уточните место или адрес, который нужно найти.",
      source: "travel_local",
    };
  }

  const url =
    "https://nominatim.openstreetmap.org/search" +
    `?format=jsonv2&limit=3&accept-language=ru&q=${encodeURIComponent(lookupQuery)}`;
  const response = await fetchWithTimeout(fetchImpl, url, {
    timeoutMs,
    headers: { "user-agent": "family-ai-orchestrator/0.1" },
  });
  if (!response.ok) {
    throw new Error(`Nominatim lookup failed with ${response.status}`);
  }

  const places = await response.json();
  if (!Array.isArray(places) || places.length === 0) {
    return {
      text: `Не нашел место: ${lookupQuery}. Уточните адрес или город.`,
      source: "travel_local",
    };
  }

  return {
    text: [
      `Нашел по запросу: ${lookupQuery}`,
      ...places.slice(0, 3).map((place, index) => (
        `${index + 1}. ${place.display_name}\n` +
        `   Координаты: ${place.lat}, ${place.lon}`
      )),
      "Источник: OpenStreetMap/Nominatim.",
    ].join("\n"),
    source: "travel_local",
    metadata: {
      query: lookupQuery,
      count: places.length,
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs, headers, redirect } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 6000);

  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers,
      redirect,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublicUrl(fetchImpl, url, { timeoutMs, dnsLookup }) {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount < 2; redirectCount += 1) {
    const checkedTarget = await assertPublicFetchUrl(currentUrl, dnsLookup);
    const response =
      fetchImpl === fetch
        ? await fetchVerifiedHttpUrl(currentUrl, checkedTarget, { timeoutMs })
        : await fetchWithTimeout(fetchImpl, currentUrl, {
            timeoutMs,
            headers: { "user-agent": "family-ai-orchestrator/0.1" },
            redirect: "manual",
          });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }

    const location = response.headers?.get?.("location");
    if (!location) {
      return response;
    }

    const redirectedUrl = new URL(location, currentUrl).toString();
    await assertPublicFetchUrl(redirectedUrl, dnsLookup);

    currentUrl = redirectedUrl;
  }

  throw new Error("Too many redirects");
}

async function assertPublicFetchUrl(url, dnsLookup) {
  if (isBlockedFetchUrl(url)) {
    throw new Error("Blocked internal URL");
  }

  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpv4Literal(hostname) || hostname.includes(":")) {
    return {
      hostname,
      address: hostname,
      family: hostname.includes(":") ? 6 : 4,
    };
  }

  const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
  if (resolved.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error("Blocked DNS resolution to internal URL");
  }

  const target = resolved[0];
  if (!target?.address) {
    throw new Error("DNS resolution returned no address");
  }

  return {
    hostname,
    address: target.address,
    family: target.family ?? (target.address.includes(":") ? 6 : 4),
  };
}

function fetchVerifiedHttpUrl(url, checkedTarget, { timeoutMs }) {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const maxResponseBytes = 1_000_000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: checkedTarget.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
          host: parsed.host,
          "user-agent": "family-ai-orchestrator/0.1",
        },
        lookup(_hostname, _options, callback) {
          callback(null, checkedTarget.address, checkedTarget.family);
        },
        servername: checkedTarget.hostname,
      },
      (response) => {
        const chunks = [];
        let byteLength = 0;

        response.on("data", (chunk) => {
          byteLength += chunk.length;
          if (byteLength > maxResponseBytes) {
            request.destroy(new Error("URL response is too large"));
            return;
          }

          chunks.push(chunk);
        });

        response.on("error", fail);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            headers: {
              get(name) {
                const value = response.headers[String(name).toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : value ?? null;
              },
            },
            text: async () => body,
          });
        });
      },
    );

    request.setTimeout(timeoutMs ?? 7000, () => {
      request.destroy(new Error("URL fetch timed out"));
    });
    request.on("error", fail);
    request.end();
  });
}

function dailyRows(daily = {}) {
  return (daily.time ?? []).map((date, index) => ({
    date,
    weatherCode: daily.weather_code?.[index],
    temperatureMax: daily.temperature_2m_max?.[index],
    temperatureMin: daily.temperature_2m_min?.[index],
    precipitationProbability: daily.precipitation_probability_max?.[index],
    precipitationSum: daily.precipitation_sum?.[index],
    windSpeedMax: daily.wind_speed_10m_max?.[index],
  }));
}

function nextWeekendRows(days) {
  const weekend = days.filter((day) => {
    const dayOfWeek = new Date(`${day.date}T12:00:00`).getDay();
    return dayOfWeek === 0 || dayOfWeek === 6;
  });

  return weekend.slice(0, 2);
}

function formatWeatherAnswer({ placeLabel, days, target, sourceLabel }) {
  if (days.length === 0) {
    return `Для ${placeLabel} прогноз пока не найден в доступном диапазоне.`;
  }

  const title =
    target === "weekend"
      ? `Погода на ближайшие выходные: ${placeLabel}`
      : `Ближайший прогноз: ${placeLabel}`;

  return [
    title,
    ...days.map((day) => {
      const label = weatherCodeLabels.get(day.weatherCode) ?? "погодные условия без расшифровки";
      return [
        `- ${day.date}: ${label}`,
        `${Math.round(day.temperatureMin)}...${Math.round(day.temperatureMax)} °C`,
        `дождь ${day.precipitationProbability ?? 0}%`,
        `осадки ${day.precipitationSum ?? 0} мм`,
        `ветер до ${Math.round(day.windSpeedMax ?? 0)} км/ч`,
      ].join(", ");
    }),
    `Источник: ${sourceLabel}.`,
  ].join("\n");
}

function extractHtmlTitle(body) {
  return decodeHtmlEntities(
    body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, " ")
      .trim() ?? "",
  );
}

function extractReadableText(body, contentType) {
  if (/json/i.test(contentType)) {
    return String(body).replace(/\s+/g, " ").trim();
  }

  return decodeHtmlEntities(
    String(body)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function isBlockedFetchUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return true;

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata.google.internal"
  ) {
    return true;
  }

  if (isIpLiteral(hostname)) {
    return isBlockedIpAddress(hostname);
  }

  return false;
}

function isBlockedFetchError(error) {
  return /^Blocked /.test(String(error?.message ?? ""));
}

function buildBlockedFetchResult(url) {
  return {
    text: [
      "Я не читаю локальные, служебные или внутренние адреса сервера.",
      "Пришлите публичную ссылку на сайт или документ.",
    ].join("\n"),
    source: "web_fetch_url",
    metadata: {
      url,
      blocked: true,
    },
  };
}

function isIpv4Literal(hostname) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(hostname);
}

function isIpLiteral(hostname) {
  return isIpv4Literal(hostname) || hostname.includes(":");
}

function isBlockedIpAddress(address) {
  const normalized = String(address ?? "").trim().toLowerCase();
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);
  if (mappedIpv4) {
    return isBlockedIpv4Address(mappedIpv4);
  }

  if (normalized.includes(":")) {
    return isBlockedIpv6Address(normalized);
  }

  return isBlockedIpv4Address(normalized);
}

function isBlockedIpv4Address(address) {
  const ipv4 = String(address ?? "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;

  const [, firstRaw, secondRaw, thirdRaw, fourthRaw] = ipv4;
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const third = Number(thirdRaw);
  const fourth = Number(fourthRaw);
  if ([first, second, third, fourth].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168
  );
}

function isBlockedIpv6Address(address) {
  const normalized = address.replace(/^\[|\]$/g, "");
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89a-f]/.test(normalized) ||
    normalized.startsWith("2001:db8")
  );
}

function ipv4FromMappedIpv6(address) {
  const normalized = address.replace(/^\[|\]$/g, "");
  if (!normalized.startsWith("::ffff:")) return null;

  const tail = normalized.slice("::ffff:".length);
  if (isIpv4Literal(tail)) return tail;

  const hextets = tail.split(":");
  if (hextets.length !== 2) return null;

  const high = Number.parseInt(hextets[0], 16);
  const low = Number.parseInt(hextets[1], 16);
  if (![high, low].every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)) {
    return null;
  }

  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

function resolveLocation(lowerText, defaultLocation) {
  for (const [alias, city] of cityAliases.entries()) {
    if (lowerText.includes(alias)) return city;
  }

  return defaultLocation;
}

function resolveTimeZone(lowerText, defaultTimeZone) {
  for (const [alias, timeZone] of timezoneAliases.entries()) {
    if (lowerText.includes(alias)) return timeZone;
  }

  return defaultTimeZone;
}

function nextWeekendDates(now, timeZone) {
  const localParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(localParts.find((part) => part.type === "year")?.value);
  const month = Number(localParts.find((part) => part.type === "month")?.value);
  const day = Number(localParts.find((part) => part.type === "day")?.value);
  const localNoon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dayOfWeek = localNoon.getUTCDay();
  const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
  const saturday = new Date(localNoon);
  saturday.setUTCDate(localNoon.getUTCDate() + daysUntilSaturday);
  const sunday = new Date(saturday);
  sunday.setUTCDate(saturday.getUTCDate() + 1);

  return { saturday, sunday };
}
