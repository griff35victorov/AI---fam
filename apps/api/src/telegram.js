export const accessNotConfiguredText =
  "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.";
export const defaultProcessedText = "Принял. Задача обработана.";
export const startCommandText =
  "Бот подключен. Напишите задачу одним сообщением.\n\nДля обучения агента напишите /learn.";
export const voiceInputNotConfiguredText =
  "Голосовой ввод пока не настроен. Нужно подключить speech-to-text endpoint в VOICE_TRANSCRIPTION_URL.";
export const imageInputNotConfiguredText =
  "Распознавание фото пока не настроено. Нужно подключить OCR provider: локальный Tesseract или OCR endpoint.";
export const documentInputNotConfiguredText =
  "Чтение файлов пока не настроено. Для обучения из Telegram можно подключить extractor текстовых файлов.";

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

function telegramTextDocumentFile(message) {
  const document = message?.document;
  if (!document?.file_id) return null;

  const mimeType = document.mime_type ?? "";
  const fileName = document.file_name ?? "";
  if (
    String(mimeType).startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif)$/i.test(String(fileName))
  ) {
    return null;
  }

  return {
    fileId: document.file_id,
    fileName,
    mimeType,
    fileSize: document.file_size,
  };
}

async function resolveTelegramMessageText(
  message,
  {
    voiceTranscriber,
    imageOcr,
    documentTextExtractor,
    botKey,
    deferMediaProcessing = false,
  } = {},
) {
  const text = telegramMessageText(message);
  const imageFile = telegramImageFile(message);
  const textDocument = telegramTextDocumentFile(message);

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

  if (textDocument?.fileId) {
    if (deferMediaProcessing && documentTextExtractor?.extractTelegramDocument) {
      return { text, mediaDeferred: true };
    }

    if (!documentTextExtractor?.extractTelegramDocument) {
      return {
        text: "",
        documentRejected: true,
        documentError: "document_extraction_not_configured",
        documentReplyText: documentInputNotConfiguredText,
      };
    }

    try {
      const extraction = await documentTextExtractor.extractTelegramDocument({
        fileId: textDocument.fileId,
        fileName: textDocument.fileName,
        mimeType: textDocument.mimeType,
        fileSize: textDocument.fileSize,
        botKey,
      });

      if (!extraction?.ok || !extraction.text) {
        return {
          text: "",
          documentRejected: true,
          documentError: extraction?.error ?? "document_extraction_empty",
          documentReplyText: extraction?.text || "Не удалось прочитать текст файла. Для обучения отправьте .txt, .md или .csv.",
        };
      }

      return {
        text: [text, extraction.text].filter(Boolean).join("\n\n"),
        documentExtracted: true,
        documentFileId: textDocument.fileId,
        documentTitle: extraction.title ?? textDocument.fileName,
      };
    } catch {
      return {
        text: "",
        documentRejected: true,
        documentError: "document_extraction_failed",
        documentReplyText: "Не удалось прочитать файл из-за ошибки Telegram/download. Попробуйте файл меньшего размера или вставьте текст сообщением.",
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
    documentTextExtractor,
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
    documentTextExtractor,
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
    documentRejected: voiceState.documentRejected,
    documentError: voiceState.documentError,
    documentReplyText: voiceState.documentReplyText,
    documentExtracted: voiceState.documentExtracted,
    documentFileId: voiceState.documentFileId,
    documentTitle: voiceState.documentTitle,
    mediaDeferred: voiceState.mediaDeferred,
    telegramUpdateId: update.update_id,
    telegramBotKey: botKey,
  };
}

function telegramReplyDeliveryKey(update, botKey) {
  if (update?.update_id == null) {
    return null;
  }

  return `telegram:${botKey ?? "default"}:${update.update_id}:reply`;
}

function telegramChatIdFromUpdate(update) {
  const chatId = update?.message?.chat?.id;
  return chatId === undefined || chatId === null ? null : chatId;
}

async function claimTelegramReplyDelivery({ repositories, update, botKey } = {}) {
  const key = telegramReplyDeliveryKey(update, botKey);
  if (!key || typeof repositories?.telegramDeliveries?.claim !== "function") {
    return { key, claimed: true, delivery: null };
  }

  const result = await repositories.telegramDeliveries.claim({
    key,
    botKey: botKey ?? "default",
    updateId: update.update_id,
    chatId: telegramChatIdFromUpdate(update),
  });

  return { key, ...result };
}

async function markTelegramReplySent({ repositories, key, chatId, text } = {}) {
  if (!key || typeof repositories?.telegramDeliveries?.markSent !== "function") {
    return;
  }

  await repositories.telegramDeliveries.markSent(key, {
    stage: "sent",
    chatId,
    textLength: String(text ?? "").length,
  });
}

async function markTelegramReplySending({ repositories, key, chatId } = {}) {
  if (!key || typeof repositories?.telegramDeliveries?.markSending !== "function") {
    return;
  }

  await repositories.telegramDeliveries.markSending(key, { chatId });
}

async function markTelegramReplyFailed({ repositories, key, stage, error } = {}) {
  if (!key || typeof repositories?.telegramDeliveries?.markFailed !== "function") {
    return;
  }

  await repositories.telegramDeliveries.markFailed(key, {
    stage,
    error: error?.message ?? String(error ?? "telegram delivery failed"),
  });
}

async function sendTelegramReply(telegramSender, { chatId, text }) {
  if (!telegramSender) {
    return;
  }

  return telegramSender.sendMessage({ chatId, text });
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
    documentTextExtractor,
  },
) {
  const delivery = telegramSender
    ? await claimTelegramReplyDelivery({ repositories, update, botKey })
    : { key: null, claimed: true, delivery: null };
  if (!delivery.claimed) {
    return {
      chatId: telegramChatIdFromUpdate(update),
      text: delivery.delivery?.result?.text ?? "",
      duplicate: true,
    };
  }

  let request;
  try {
    request = repositories?.users
      ? await buildTelegramRequestFromRepositories(update, {
          repositories,
          botKey,
          voiceTranscriber,
          imageOcr,
          documentTextExtractor,
        })
      : buildTelegramRequest(update, { users, botKey });
  } catch (error) {
    await markTelegramReplyFailed({
      repositories,
      key: delivery.key,
      stage: "processing",
      error,
    });
    throw error;
  }

  async function finish({ chatId, text }) {
    try {
      await markTelegramReplySending({ repositories, key: delivery.key, chatId });
      await sendTelegramReply(telegramSender, { chatId, text });
      await markTelegramReplySent({ repositories, key: delivery.key, chatId, text });
    } catch (error) {
      await markTelegramReplyFailed({
        repositories,
        key: delivery.key,
        stage: "send",
        error,
      });
      throw error;
    }

    return { chatId, text };
  }

  if (request.rejected) {
    const text = accessNotConfiguredText;
    return finish({ chatId: request.chatId, text });
  }

  if (request.isStartCommand) {
    const text = startCommandText;
    return finish({ chatId: request.chatId, text });
  }

  if (request.voiceRejected) {
    const text = request.voiceReplyText ?? voiceInputNotConfiguredText;
    return finish({ chatId: request.chatId, text });
  }

  if (request.imageRejected) {
    const text = request.imageReplyText ?? imageInputNotConfiguredText;
    return finish({ chatId: request.chatId, text });
  }

  if (request.documentRejected) {
    const text = request.documentReplyText ?? documentInputNotConfiguredText;
    return finish({ chatId: request.chatId, text });
  }

  let result;
  try {
    result = await orchestrator(request);
  } catch (error) {
    await markTelegramReplyFailed({
      repositories,
      key: delivery.key,
      stage: "processing",
      error,
    });
    throw error;
  }

  const text = result.answer?.text ?? defaultProcessedText;
  return finish({ chatId: request.chatId, text });
}
