const accessNotConfiguredText =
  "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.";
const defaultProcessedText = "Принял. Задача обработана.";

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

export function resolveTelegramActor(message, users) {
  const telegramUserId = String(message?.from?.id ?? "");
  const user = users.find((candidate) => candidate.telegramUserId === telegramUserId);
  if (!user) return null;

  return actorFromUser(user);
}

export async function resolveTelegramActorFromRepositories(message, repositories) {
  const telegramUserId = String(message?.from?.id ?? "");
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
  const actor = resolveTelegramActor(message, users);
  if (!actor) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "unknown_telegram_user",
    };
  }

  if (!telegramBotAcceptsActor(botKey, actor)) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "telegram_bot_role_mismatch",
    };
  }

  const text = message.text ?? "";

  return {
    chatId: message.chat.id,
    actor,
    intent: inferIntentFromText(actor, text),
    text,
    telegramUpdateId: update.update_id,
    telegramBotKey: botKey,
  };
}

export async function buildTelegramRequestFromRepositories(update, { repositories, botKey } = {}) {
  const message = update.message;
  const actor = await resolveTelegramActorFromRepositories(message, repositories);
  if (!actor) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "unknown_telegram_user",
    };
  }

  if (!telegramBotAcceptsActor(botKey, actor)) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "telegram_bot_role_mismatch",
    };
  }

  const text = message.text ?? "";

  return {
    chatId: message.chat.id,
    actor,
    intent: inferIntentFromText(actor, text),
    text,
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
  { users = [], repositories, orchestrator, telegramSender, botKey },
) {
  const request = repositories?.users
    ? await buildTelegramRequestFromRepositories(update, { repositories, botKey })
    : buildTelegramRequest(update, { users, botKey });

  if (request.rejected) {
    const text = accessNotConfiguredText;
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
