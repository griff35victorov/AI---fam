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

function buildSystemMessage({ agentProfile, memoryContext }) {
  const contextBlock = memoryContext ? `\n\nAllowed memory:\n${memoryContext}` : "";
  return {
    role: "system",
    content: `You are ${agentProfile}. Use only allowed memory and follow confirmation policy.${contextBlock}`,
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
