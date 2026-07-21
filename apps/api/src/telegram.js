export const accessNotConfiguredText =
  "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.";
export const defaultProcessedText = "Принял. Задача обработана.";
export const startCommandText = "Бот подключен. Напишите задачу одним сообщением.";
export const voiceInputNotConfiguredText =
  "Голосовой ввод пока не настроен. Нужно подключить speech-to-text endpoint в VOICE_TRANSCRIPTION_URL.";

const expectedRoleByBotKey = {
  owner: "owner",
  daughter: "family_child",
  teacher: "teacher",
};

function actorFromUser(user) {
  const actor = {
    id: user.id,
    role: user.role,
  };

  if (user.workspaceId != null) {
    actor.workspaceId = user.workspaceId;
  }

  return actor;
}

function telegramUserIdFromMessage(message) {
  return String(message?.from?.id ?? "");
}

function telegramMessageText(message) {
  return message?.text ?? message?.caption ?? "";
}

async function resolveTelegramMessageText(message, { voiceTranscriber, botKey } = {}) {
  const text = telegramMessageText(message);
  if (text) {
    return { text };
  }

  const voice = message?.voice;
  if (!voice?.file_id) {
    return { text: "" };
  }

  if (!voiceTranscriber?.transcribeTelegramVoice) {
    return {
      text: "",
      voiceRejected: true,
      voiceError: "voice_transcription_not_configured",
      voiceReplyText: voiceInputNotConfiguredText,
    };
  }

  try {
    const transcription = await voiceTranscriber.transcribeTelegramVoice({
      fileId: voice.file_id,
      duration: voice.duration,
      botKey,
    });

    if (!transcription?.ok || !transcription.text) {
      return {
        text: "",
        voiceRejected: true,
        voiceError: transcription?.error ?? "voice_transcription_empty",
        voiceReplyText: transcription?.text || "Не удалось распознать голосовое сообщение. Попробуйте сказать короче или отправьте текстом.",
      };
    }

    return {
      text: transcription.text,
      voiceTranscribed: true,
      voiceFileId: voice.file_id,
    };
  } catch (error) {
    return {
      text: "",
      voiceRejected: true,
      voiceError: "voice_transcription_failed",
      voiceReplyText: "Не удалось распознать голосовое сообщение из-за ошибки STT-сервиса. Попробуйте текстом или напишите: диагностика.",
    };
  }
}

export function accessNotConfiguredTextForRequest(request) {
  return request.telegramUserId
    ? `${accessNotConfiguredText}\n\nTelegram ID: ${request.telegramUserId}`
    : accessNotConfiguredText;
}

export function resolveTelegramActor(message, users) {
  const telegramUserId = telegramUserIdFromMessage(message);
  const user = users.find((candidate) => candidate.telegramUserId === telegramUserId);
  if (!user) return null;

  return actorFromUser(user);
}

export async function resolveTelegramActorFromRepositories(message, repositories) {
  const telegramUserId = telegramUserIdFromMessage(message);
  if (!telegramUserId) return null;

  const user = await repositories.users.findByTelegramUserId(telegramUserId);
  if (!user) return null;

  return actorFromUser(user);
}

export function telegramBotAcceptsActor(botKey, actor) {
  const expectedRole = expectedRoleByBotKey[botKey];
  return !expectedRole || actor?.role === expectedRole;
}

export function inferIntentFromText(actor, text) {
  const normalized = text.toLowerCase();

  if (normalized.includes("напом")) return "reminder";
  if (normalized.includes("бесед")) return "gazebo_design";

  if (actor.role === "teacher") {
    if (
      normalized.includes("материал") ||
      normalized.includes("библиотек") ||
      normalized.includes("worksheet") ||
      normalized.includes("materials")
    ) {
      return "material_search";
    }
    if (normalized.includes("урок") || normalized.includes("lesson")) return "lesson_preparation";
    if (normalized.includes("ученик")) return "student_schedule";
  }

  if (actor.role === "family_child") {
    if (normalized.includes("англий") || normalized.includes("english")) return "english_practice";
    if (normalized.includes("егэ")) return "ege_preparation";
    return "school_help";
  }

  if (normalized.includes("товар") || normalized.includes("купить")) return "product_search";
  if (normalized.includes("посчитай") || normalized.includes("расчет") || normalized.includes("расчёт")) return "calculation";

  return "household";
}

export function buildTelegramRequest(update, { users, botKey } = {}) {
  const message = update.message;
  const telegramUserId = telegramUserIdFromMessage(message);
  const actor = resolveTelegramActor(message, users);
  if (!actor) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "unknown_telegram_user",
      telegramUserId,
    };
  }

  if (!telegramBotAcceptsActor(botKey, actor)) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "telegram_bot_role_mismatch",
      telegramUserId,
    };
  }

  const text = telegramMessageText(message);

  return {
    chatId: message.chat.id,
    actor,
    intent: inferIntentFromText(actor, text),
    isStartCommand: text.trim().toLowerCase() === "/start",
    text,
    telegramUpdateId: update.update_id,
    telegramBotKey: botKey,
  };
}

export async function buildTelegramRequestFromRepositories(
  update,
  { repositories, botKey, voiceTranscriber } = {},
) {
  const message = update.message;
  const telegramUserId = telegramUserIdFromMessage(message);
  const actor = await resolveTelegramActorFromRepositories(message, repositories);
  if (!actor) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "unknown_telegram_user",
      telegramUserId,
    };
  }

  if (!telegramBotAcceptsActor(botKey, actor)) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "telegram_bot_role_mismatch",
      telegramUserId,
    };
  }

  const voiceState = await resolveTelegramMessageText(message, {
    voiceTranscriber,
    botKey,
  });
  const text = voiceState.text ?? "";

  return {
    chatId: message.chat.id,
    actor,
    intent: inferIntentFromText(actor, text),
    isStartCommand: text.trim().toLowerCase() === "/start",
    text,
    voiceRejected: voiceState.voiceRejected,
    voiceError: voiceState.voiceError,
    voiceReplyText: voiceState.voiceReplyText,
    voiceTranscribed: voiceState.voiceTranscribed,
    voiceFileId: voiceState.voiceFileId,
    telegramUpdateId: update.update_id,
    telegramBotKey: botKey,
  };
}

async function sendTelegramReply(telegramSender, { chatId, text }) {
  if (!telegramSender) {
    return;
  }

  await telegramSender.sendMessage({ chatId, text });
}

export async function handleTelegramUpdate(
  update,
  { users = [], repositories, orchestrator, telegramSender, botKey, voiceTranscriber },
) {
  const request = repositories?.users
    ? await buildTelegramRequestFromRepositories(update, {
        repositories,
        botKey,
        voiceTranscriber,
      })
    : buildTelegramRequest(update, { users, botKey });

  if (request.rejected) {
    const text = accessNotConfiguredText;
    await sendTelegramReply(telegramSender, { chatId: request.chatId, text });

    return {
      chatId: request.chatId,
      text,
    };
  }

  if (request.isStartCommand) {
    const text = startCommandText;
    await sendTelegramReply(telegramSender, { chatId: request.chatId, text });

    return {
      chatId: request.chatId,
      text,
    };
  }

  if (request.voiceRejected) {
    const text = request.voiceReplyText ?? voiceInputNotConfiguredText;
    await sendTelegramReply(telegramSender, { chatId: request.chatId, text });

    return {
      chatId: request.chatId,
      text,
    };
  }

  const result = await orchestrator(request);
  const text = result.answer?.text ?? defaultProcessedText;
  await sendTelegramReply(telegramSender, { chatId: request.chatId, text });

  return {
    chatId: request.chatId,
    text,
  };
}
