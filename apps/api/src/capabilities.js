export const capabilityCatalog = [
  {
    id: "weather_forecast",
    title: "Weather forecast",
    description: "Open-Meteo forecast by city, including weekend weather.",
  },
  {
    id: "web_current_data",
    title: "Current web data",
    description: "Requires a connected web search/fetch provider.",
  },
  {
    id: "voice_input",
    title: "Telegram voice input",
    description: "Requires a speech-to-text endpoint.",
  },
  {
    id: "calendar_scheduling",
    title: "Calendar scheduling",
    description: "Requires Google Calendar, CalDAV, or Microsoft Calendar access.",
  },
  {
    id: "email_triage",
    title: "Email triage",
    description: "Requires Gmail, Outlook, or IMAP access.",
  },
  {
    id: "materials_rag",
    title: "Teacher materials library",
    description: "Uses the internal PostgreSQL material chunks.",
  },
];

const cityAliases = new Map([
  ["москве", "Москва"],
  ["москва", "Москва"],
  ["moscow", "Moscow"],
  ["санкт-петербурге", "Санкт-Петербург"],
  ["питере", "Санкт-Петербург"],
  ["спб", "Санкт-Петербург"],
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
  weatherTimeoutMs = 6000,
  voiceTranscriber,
  webSearch,
} = {}) {
  return {
    list() {
      return capabilityCatalog.map((capability) => ({
        ...capability,
        available: capabilityAvailable(capability.id, {
          fetchImpl,
          voiceTranscriber,
          webSearch,
        }),
      }));
    },

    has(capabilityId) {
      return capabilityAvailable(capabilityId, {
        fetchImpl,
        voiceTranscriber,
        webSearch,
      });
    },

    async run(capabilityId, args = {}) {
      if (capabilityId === "weather_forecast") {
        return fetchWeatherForecast({ ...args, fetchImpl, timeoutMs: weatherTimeoutMs });
      }

      if (capabilityId === "voice_input" && voiceTranscriber) {
        return voiceTranscriber.transcribeTelegramVoice(args);
      }

      if (capabilityId === "web_current_data" && webSearch) {
        return webSearch.search(args);
      }

      throw new Error(`Capability is not available: ${capabilityId}`);
    },
  };
}

function capabilityAvailable(capabilityId, { fetchImpl, voiceTranscriber, webSearch }) {
  if (capabilityId === "weather_forecast") return Boolean(fetchImpl);
  if (capabilityId === "voice_input") return Boolean(voiceTranscriber);
  if (capabilityId === "web_current_data") return Boolean(webSearch);
  if (capabilityId === "materials_rag") return true;
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

export function isCurrentDataRequest(text) {
  const normalized = String(text ?? "").toLowerCase();
  return /(?:актуальн|новост|курс|цена|стоимост|наличии|расписан|рейс|котировк|current|latest|price|schedule|available)/i.test(normalized);
}

export function buildCapabilitiesAnswer(registry) {
  const capabilities = registry?.list?.() ?? capabilityCatalog.map((item) => ({
    ...item,
    available: false,
  }));

  return [
    "Инструменты оркестра:",
    ...capabilities.map((capability) => {
      const status = capability.available ? "подключен" : "нужен доступ";
      return `- ${capability.id}: ${status}`;
    }),
  ].join("\n");
}

export function buildMissingCurrentDataCapabilityAnswer(text) {
  const capability = isWeatherRequest(text) ? "weather_forecast" : "web_current_data";

  return [
    "Для этого запроса нужны актуальные данные, а не ответ по памяти.",
    `Нужный инструмент: ${capability}.`,
    "Я не буду отправлять вас проверять сайт вручную; нужно подключить этот источник к оркестру.",
  ].join("\n");
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
    text: formatWeatherAnswer({ placeLabel, days: selectedDays, target }),
    source: "weather_forecast",
    metadata: {
      location: placeLabel,
      latitude: place.latitude,
      longitude: place.longitude,
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

function formatWeatherAnswer({ placeLabel, days, target }) {
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
    "Источник: Open-Meteo.",
  ].join("\n");
}
