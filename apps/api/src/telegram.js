export function resolveTelegramActor(message, users) {
  const telegramUserId = String(message?.from?.id ?? "");
  const user = users.find((candidate) => candidate.telegramUserId === telegramUserId);
  if (!user) return null;

  return {
    id: user.id,
    role: user.role,
  };
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
  if (normalized.includes("посчитай") || normalized.includes("расчет")) return "calculation";

  return "household";
}

export function buildTelegramRequest(update, { users }) {
  const message = update.message;
  const actor = resolveTelegramActor(message, users);
  if (!actor) {
    return {
      chatId: message?.chat?.id,
      rejected: true,
      reason: "unknown_telegram_user",
    };
  }

  const text = message.text ?? "";

  return {
    chatId: message.chat.id,
    actor,
    intent: inferIntentFromText(actor, text),
    text,
  };
}

export async function handleTelegramUpdate(update, { users, orchestrator }) {
  const request = buildTelegramRequest(update, { users });

  if (request.rejected) {
    return {
      chatId: request.chatId,
      text: "Доступ не настроен. Обратитесь к владельцу семейного оркестратора.",
    };
  }

  const result = await orchestrator(request);

  return {
    chatId: request.chatId,
    text: result.answer?.text ?? "Принял. Задача обработана.",
  };
}
