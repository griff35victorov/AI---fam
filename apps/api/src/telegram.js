export const accessNotConfiguredText =
  "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.";
export const defaultProcessedText = "Принял. Задача обработана.";
export const startCommandText = "Бот подключен. Напишите задачу одним сообщением.";
export const voiceInputNotConfiguredText =
  "Голосовой ввод пока не настроен. Нужно подключить speech-to-text endpoint в VOICE_TRANSCRIPTION_URL.";
export const imageInputNotConfiguredText =
  "Распознавание фото пока не настроено. Нужно подключить OCR provider: локальный Tesseract или OCR endpoint.";

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

function telegramImageFile(message) {
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  const photo = [...photos].sort((left, right) => (
    (right.file_size ?? 0) - (left.file_size ?? 0)
  ))[0];
  if (photo?.file_id) {
    return {
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      kind: "photo",
    };
  }

  const document = message?.document;
  if (
    document?.file_id &&
    (
      String(document.mime_type ?? "").startsWith("image/") ||
      /\.(?:png|jpe?g|webp|gif)$/i.test(String(document.file_name ?? ""))
    )
  ) {
    return {
      fileId: document.file_id,
      mimeType: document.mime_type ?? "image/jpeg",
      kind: "document",
    };
  }

  return null;
}

async function resolveTelegramMessageText(
  message,
  {
    voiceTranscriber,
    imageOcr,
    botKey,
    deferMediaProcessing = false,
  } = {},
) {
  const text = telegramMessageText(message);
  const imageFile = telegramImageFile(message);

  if (imageFile?.fileId) {
    if (deferMediaProcessing && imageOcr?.recognizeTelegramImage) {
      return { text, mediaDeferred: true };
    }

    if (!imageOcr?.recognizeTelegramImage) {
      return {
        text: "",
        imageRejected: true,
        imageError: "ocr_not_configured",
        imageReplyText: imageInputNotConfiguredText,
      };
    }

    try {
      const recognition = await imageOcr.recognizeTelegramImage({
        fileId: imageFile.fileId,
        mimeType: imageFile.mimeType,
        kind: imageFile.kind,
        botKey,
      });

      if (!recognition?.ok || !recognition.text) {
        return {
          text: "",
          imageRejected: true,
          imageError: recognition?.error ?? "ocr_empty",
          imageReplyText: recognition?.text || "Не удалось распознать текст на изображении. Попробуйте прислать более четкое фото.",
        };
      }

      return {
        text: [text, `Текст с изображения:\n${recognition.text}`]
          .filter(Boolean)
          .join("\n\n"),
        imageRecognized: true,
        imageFileId: imageFile.fileId,
      };
    } catch {
      return {
        text: "",
        imageRejected: true,
        imageError: "ocr_failed",
        imageReplyText: "Не удалось распознать изображение из-за ошибки OCR. Попробуйте фото меньшего размера или напишите текстом.",
      };
    }
  }

  if (text) {
    return { text };
  }

  const voice = message?.voice;
  if (!voice?.file_id) {
    return { text: "" };
  }

  if (deferMediaProcessing && voiceTranscriber?.transcribeTelegramVoice) {
    return { text: "", mediaDeferred: true };
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
  {
    repositories,
    botKey,
    voiceTranscriber,
    imageOcr,
    deferMediaProcessing = false,
  } = {},
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
    imageOcr,
    botKey,
    deferMediaProcessing,
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
    imageRejected: voiceState.imageRejected,
    imageError: voiceState.imageError,
    imageReplyText: voiceState.imageReplyText,
    imageRecognized: voiceState.imageRecognized,
    imageFileId: voiceState.imageFileId,
    mediaDeferred: voiceState.mediaDeferred,
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
  {
    users = [],
    repositories,
    orchestrator,
    telegramSender,
    botKey,
    voiceTranscriber,
    imageOcr,
  },
) {
  const request = repositories?.users
    ? await buildTelegramRequestFromRepositories(update, {
        repositories,
        botKey,
        voiceTranscriber,
        imageOcr,
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

  if (request.imageRejected) {
    const text = request.imageReplyText ?? imageInputNotConfiguredText;
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
