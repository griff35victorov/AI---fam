const defaultTimeZone = "Europe/Moscow";

const relativeUnits = [
  { pattern: /минут(?:у|ы)?|мин\b/i, ms: 60_000 },
  { pattern: /час(?:а|ов)?/i, ms: 60 * 60_000 },
  { pattern: /д(?:ень|ня|ней)/i, ms: 24 * 60 * 60_000 },
  { pattern: /minute|minutes|min\b/i, ms: 60_000 },
  { pattern: /hour|hours/i, ms: 60 * 60_000 },
  { pattern: /day|days/i, ms: 24 * 60 * 60_000 },
];

function timeZoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return localAsUtc - date.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour = 9, minute = 0 }, timeZone) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  return new Date(utcGuess.getTime() - timeZoneOffsetMs(utcGuess, timeZone));
}

function addDaysToZonedDate(now, dayOffset, timeZone) {
  const parts = timeZoneParts(now, timeZone);
  const noonUtc = zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day + dayOffset,
      hour: 12,
      minute: 0,
    },
    timeZone,
  );
  return timeZoneParts(noonUtc, timeZone);
}

function parseClockTime(text) {
  const match =
    String(text ?? "").match(/(?:^|\s)(?:в|к|at)\s*(\d{1,2})(?::(\d{2}))?/i) ??
    String(text ?? "").match(/\b(\d{1,2}):(\d{2})\b/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

function parseRelativeReminderDate(text, now) {
  const match = String(text ?? "").match(/(?:через|in)\s+(\d{1,4})\s+([A-Za-zА-Яа-яЁё.]+)/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = relativeUnits.find((candidate) => candidate.pattern.test(match[2]));
  if (!Number.isFinite(amount) || amount <= 0 || !unit) return null;

  return new Date(now.getTime() + amount * unit.ms);
}

function parseExplicitReminderDate(text, timeZone) {
  const normalized = String(text ?? "");
  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})[ T,]+(\d{1,2})(?::(\d{2}))?\b/);
  if (isoMatch) {
    return zonedDateTimeToUtc(
      {
        year: Number(isoMatch[1]),
        month: Number(isoMatch[2]),
        day: Number(isoMatch[3]),
        hour: Number(isoMatch[4]),
        minute: Number(isoMatch[5] ?? 0),
      },
      timeZone,
    );
  }

  const ruMatch = normalized.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(?:в\s*)?(\d{1,2})(?::(\d{2}))?\b/);
  if (ruMatch) {
    const currentYear = timeZoneParts(new Date(), timeZone).year;
    return zonedDateTimeToUtc(
      {
        year: Number(ruMatch[3] ?? currentYear),
        month: Number(ruMatch[2]),
        day: Number(ruMatch[1]),
        hour: Number(ruMatch[4]),
        minute: Number(ruMatch[5] ?? 0),
      },
      timeZone,
    );
  }

  return null;
}

function parseNamedDayReminderDate(text, now, timeZone) {
  const lower = String(text ?? "").toLowerCase();
  const dayOffset = lower.includes("послезавтра")
    ? 2
    : lower.includes("завтра") || lower.includes("tomorrow")
      ? 1
      : lower.includes("сегодня") || lower.includes("today")
        ? 0
        : null;

  if (dayOffset == null) return null;

  const clock = parseClockTime(text) ?? { hour: 9, minute: 0 };
  const day = addDaysToZonedDate(now, dayOffset, timeZone);
  return zonedDateTimeToUtc(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: clock.hour,
      minute: clock.minute,
    },
    timeZone,
  );
}

function cleanupReminderTitle(text) {
  return String(text ?? "")
    .replace(/^\/remind(?:er)?\s*/i, "")
    .replace(/^(?:напомни|напомнить|создай напоминание|поставь напоминание|remind me)\s*,?\s*/i, "")
    .replace(/(?:через|in)\s+\d{1,4}\s+[A-Za-zА-Яа-яЁё.]+/gi, "")
    .replace(/(?:^|\s)(?:сегодня|завтра|послезавтра|today|tomorrow)(?=\s|$)/gi, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}[ T,]+\d{1,2}(?::\d{2})?\b/g, "")
    .replace(/\b\d{1,2}\.\d{1,2}(?:\.\d{4})?\s+(?:в\s*)?\d{1,2}(?::\d{2})?\b/g, "")
    .replace(/(?:^|\s)(?:в|к|at)\s*\d{1,2}(?::\d{2})?(?=\s|$)/gi, " ")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseReminderRequest(text, { now = new Date(), timeZone = defaultTimeZone } = {}) {
  const dueAt =
    parseRelativeReminderDate(text, now) ??
    parseExplicitReminderDate(text, timeZone) ??
    parseNamedDayReminderDate(text, now, timeZone);
  const title = cleanupReminderTitle(text);

  if (!dueAt) {
    return {
      ok: false,
      title,
      error: "missing_due_at",
    };
  }

  return {
    ok: true,
    title: title || "Напоминание",
    dueAt,
    timeZone,
  };
}

export function formatReminderDate(date, timeZone = defaultTimeZone) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function createLocalTasksProvider({
  remindersRepository,
  jobsRepository,
  defaultTimezone = defaultTimeZone,
  now = () => new Date(),
} = {}) {
  return {
    async createReminder({
      actor,
      workspaceId,
      chatId,
      botKey,
      text,
      timeZone = defaultTimezone,
    } = {}) {
      if (!remindersRepository?.create) {
        throw new Error("Local reminders repository is not configured");
      }

      const parsed = parseReminderRequest(text, {
        now: now(),
        timeZone,
      });

      if (!parsed.ok) {
        return {
          text: [
            "Я могу поставить напоминание, но мне нужна дата или время.",
            "Пример: «Напомни завтра в 09:00 купить лампы» или «Напомни через 30 минут проверить духовку».",
          ].join("\n"),
          source: "tasks_reminders",
          metadata: {
            requiresClarification: true,
            error: parsed.error,
          },
        };
      }

      const reminder = await remindersRepository.create({
        userId: actor.id,
        workspaceId,
        title: parsed.title,
        runAt: parsed.dueAt,
        timezone: parsed.timeZone,
        status: "scheduled",
      });

      if (jobsRepository?.enqueue) {
        await jobsRepository.enqueue({
          type: "send_reminder",
          payload: {
            reminderId: reminder.id,
            title: reminder.title,
            chatId,
            botKey,
            userId: actor.id,
            workspaceId,
          },
          runAt: reminder.runAt,
          dedupeKey: `send_reminder:${reminder.id}`,
        });
      }

      return {
        text: [
          `Напоминание создано: ${reminder.title}`,
          `Когда: ${formatReminderDate(reminder.runAt, reminder.timezone)}`,
          jobsRepository?.enqueue
            ? "Бот отправит сообщение сам в назначенное время."
            : "Напоминание сохранено, но отправщик задач пока не подключен.",
        ].join("\n"),
        source: "tasks_reminders",
        metadata: {
          reminderId: reminder.id,
          runAt: new Date(reminder.runAt).toISOString(),
          timezone: reminder.timezone,
        },
      };
    },

    async listUpcoming({
      actor,
      workspaceId,
      limit = 5,
      timeZone = defaultTimezone,
    } = {}) {
      if (!remindersRepository?.listUpcoming) {
        return [];
      }

      const reminders = await remindersRepository.listUpcoming({
        userId: actor?.id,
        workspaceId,
        now: now(),
        limit,
      });

      return reminders.map((reminder) => ({
        ...reminder,
        displayTime: formatReminderDate(reminder.runAt, reminder.timezone ?? timeZone),
      }));
    },
  };
}
