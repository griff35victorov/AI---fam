import {
  requiresConfirmation,
  routeAgentProfile,
} from "../../../packages/domain/src/index.js";
import { resolveModelProfile } from "../../../packages/ai/src/index.js";
import { buildAllowedMemoryContext, formatMemoryContext } from "./context.js";

const taskTypeByIntent = {
  gazebo_design: "gazebo_design",
  technical_question: "technical_analysis",
  lesson_preparation: "lesson_preparation",
  ege_preparation: "ege_explanation",
  english_practice: "english_practice",
  reminder: "reminder_summary",
};

const agentProfileDescriptions = {
  family_dispatcher:
    "семейный диспетчер: быстро понимаешь задачу, уточняешь недостающее и направляешь к нужному профилю",
  owner_assistant:
    "личный помощник владельца: бытовые дела, техника, расчеты, покупки, планирование, чертежи и практичные решения",
  shopping_assistant:
    "помощник по товарам: сравнение вариантов, критерии выбора, список вопросов перед покупкой",
  design_assistant:
    "помощник по дизайну и проектированию: беседки, планировки, размеры, материалы и пошаговые эскизные решения",
  teacher_methodologist:
    "методист преподавателя английского: планы уроков, упражнения, уровни CEFR, домашние задания и методика",
  teacher_secretary:
    "секретарь преподавателя: расписание, ученики, заметки, коммуникации и аккуратная организация работы",
  materials_librarian:
    "библиотекарь материалов преподавателя: помогает структурировать, находить и переиспользовать учебные материалы",
  communication_assistant:
    "помощник по сообщениям: составляет вежливые тексты, но внешние отправки требуют подтверждения",
  daughter_tutor:
    "учебный помощник дочери: школьные предметы, подготовка, объяснение простыми словами и проверка понимания",
  daughter_english_coach:
    "тренер английского для дочери: практика слов, грамматики, чтения, письма и разговорных фраз",
  scheduler:
    "помощник по календарю и напоминаниям: помогает сформулировать событие, дату, время и подтверждение",
};

function buildSystemMessage({ agentProfile, memoryContext }) {
  const contextBlock = memoryContext ? `\n\nAllowed memory:\n${memoryContext}` : "";
  return {
    role: "system",
    content: [
      `Ты ${agentProfileDescriptions[agentProfile] ?? agentProfile}.`,
      "Отвечай по-русски, конкретно и полезно. Не изображай всезнание: если данных мало, задай 1-2 точных уточняющих вопроса.",
      "Используй разрешенную память и недавнюю историю диалога. Не раскрывай секреты, токены, приватные данные других членов семьи или учеников.",
      "Если задача требует внешнего действия, покупки, сообщения, удаления данных или траты денег, сначала попроси подтверждение.",
      "Для учебы не просто давай ответ: объясняй ход решения и проверяй понимание. Для бытовых задач давай практичный план действий.",
      contextBlock,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function normalizeText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[?!.,]+$/g, "");
}

function roleLabel(role) {
  if (role === "owner") return "владелец семейного AI-оркестра";
  if (role === "family_child") return "ученик в семейном AI-оркестре";
  if (role === "teacher") return "учитель и преподаватель в семейном AI-оркестре";
  return "пользователь семейного AI-оркестра";
}

function buildFastAnswer(request) {
  const text = normalizeText(request.text);
  if (!text) return null;

  if (["статус", "проверка", "тест"].includes(text)) {
    return "Связь работает. Я получил сообщение и могу отвечать в этом чате.";
  }

  if (text === "кто я" || text === "who am i") {
    return `Вы подключены как ${roleLabel(request.actor?.role)}.`;
  }

  if (
    text === "что ты умеешь" ||
    text === "что умеешь" ||
    text === "/help" ||
    text === "help"
  ) {
    return [
      "Я могу помогать с бытовыми задачами, объяснять сложные темы, делать расчеты, готовить тексты, помогать с английским и учебой.",
      "Для сложных задач я подключаю профильного AI-агента; для коротких системных вопросов отвечаю сразу.",
    ].join("\n");
  }

  if (text.includes("голос") || text.includes("voice")) {
    return "Пока я надежно обрабатываю текстовые сообщения. Голосовой ввод можно добавить отдельным модулем распознавания речи.";
  }

  return null;
}

function recentMessagesForPrompt(recentMessages = []) {
  return recentMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .filter((message) => typeof message.content === "string" && message.content.trim() !== "")
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export async function handleOrchestratorRequest(request, dependencies = {}) {
  const agentProfile = routeAgentProfile(request.actor, request.intent);
  const needsConfirmation = request.action
    ? requiresConfirmation(request.action)
    : false;
  const taskType = taskTypeByIntent[request.intent] ?? "routing";
  const modelProfile = resolveModelProfile(taskType);
  const fastAnswer = buildFastAnswer(request);
  if (fastAnswer) {
    return {
      agentProfile,
      modelProfile,
      requiresConfirmation: needsConfirmation,
      accepted: true,
      answer: {
        text: fastAnswer,
        source: "local_fast_reply",
      },
    };
  }

  const allowedMemories = buildAllowedMemoryContext({
    actor: request.actor,
    memories: request.memories ?? [],
    action: "read",
  });
  const memoryContext = formatMemoryContext(allowedMemories);
  const messages = [
    buildSystemMessage({ agentProfile, memoryContext }),
    ...recentMessagesForPrompt(request.recentMessages),
    { role: "user", content: request.text ?? "" },
  ];
  const answer = dependencies.aiProvider
    ? await dependencies.aiProvider.complete({
        agentProfile,
        modelProfile,
        messages,
      })
    : null;

  return {
    agentProfile,
    modelProfile,
    requiresConfirmation: needsConfirmation,
    accepted: true,
    answer,
  };
}
