import { handleOrchestratorRequest } from "./orchestrator.js";
import { canStoreMemory } from "../../../packages/domain/src/index.js";
import { buildAllowedMemoryContext } from "./context.js";

const defaultAnswer = "Принял. Задача обработана.";
const memoryContextLimit = 20;
const recentConversationLookupLimit = 16;

function conversationIdForRequest(request) {
  return request.conversationId ?? `telegram:${request.chatId}:${request.actor.id}`;
}

function workspaceIdForRequest(request, fallbackWorkspaceId) {
  return request.actor.workspaceId ?? request.workspaceId ?? fallbackWorkspaceId;
}

function sameTelegramUpdate(message, telegramUpdateId, metadataKey) {
  return (
    telegramUpdateId != null &&
    String(message.metadata?.[metadataKey]) === String(telegramUpdateId)
  );
}

async function findExistingTelegramExchange(repositories, conversationId, telegramUpdateId) {
  if (telegramUpdateId == null || !repositories.conversations.listMessages) {
    return { userMessage: null, assistantMessage: null, messages: [] };
  }

  const messages = await repositories.conversations.listMessages(conversationId, {
    limit: recentConversationLookupLimit,
  });

  return {
    messages,
    userMessage:
      messages.find(
        (message) =>
          message.role === "user" &&
          sameTelegramUpdate(message, telegramUpdateId, "telegramUpdateId"),
      ) ?? null,
    assistantMessage:
      messages.find(
        (message) =>
          message.role === "assistant" &&
          sameTelegramUpdate(message, telegramUpdateId, "replyToTelegramUpdateId"),
      ) ?? null,
  };
}

function memoryScopeForActor(actor) {
  if (actor?.role === "teacher") return "teacher_private";
  if (actor?.role === "family_child") return "child_learning";
  return "family";
}

function extractExplicitMemory(text) {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(/^(?:запомни|сохрани|запиши)\s*,?\s*(?:что\s+)?(.+)$/i);
  const content = match?.[1]?.trim();
  return content ? content.replace(/[.!?]+$/g, "").trim() : null;
}

function normalizeText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[?!.,]+$/g, "");
}

function isMemoryRecallRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized.includes("что ты помнишь") ||
    normalized.includes("что помнишь") ||
    normalized.includes("что ты запомнил") ||
    normalized.includes("что запомнил")
  );
}

function buildMemoryRecallAnswer({ actor, memories }) {
  const allowedMemories = buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  });

  if (allowedMemories.length === 0) {
    return "Пока я ничего не сохранил в твою память. Можно написать: «Запомни, что я люблю короткие ответы».";
  }

  const lines = allowedMemories
    .slice(-8)
    .map((memory) => `- ${memory.content}`);

  return [
    "Вот что я сейчас помню:",
    ...lines,
    "Чтобы добавить новый факт, напиши: «Запомни, что ...».",
  ].join("\n");
}

const sensitiveMemoryPatterns = [
  /(?:парол|password|passcode|токен|token|api[-_\s]?key|секрет|secret|ключ доступа|access key)/i,
  /(?:номер карты|банковск(?:ая|ой|ие)? карт|cvv|cvc|паспорт|снилс|инн)/i,
];

function isSensitiveMemoryContent(content) {
  return sensitiveMemoryPatterns.some((pattern) => pattern.test(content));
}

function recentMessagesForPrompt(messages, telegramUpdateId, limit = 6) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => {
      if (message.role === "user") {
        return !sameTelegramUpdate(message, telegramUpdateId, "telegramUpdateId");
      }

      return !sameTelegramUpdate(message, telegramUpdateId, "replyToTelegramUpdateId");
    })
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

export function createRepositoryBackedOrchestrator({
  repositories,
  aiProvider,
  workspaceId = "workspace-family",
  now = () => new Date(),
} = {}) {
  if (!repositories) {
    throw new Error("repositories are required");
  }

  return async function repositoryBackedOrchestrator(request) {
    const conversationId = conversationIdForRequest(request);
    const requestWorkspaceId = workspaceIdForRequest(request, workspaceId);
    const createdAt = now();
    const { userMessage, assistantMessage, messages } =
      await findExistingTelegramExchange(
        repositories,
        conversationId,
        request.telegramUpdateId,
      );

    if (assistantMessage) {
      return {
        accepted: true,
        answer: { text: assistantMessage.content },
        conversationId,
        idempotent: true,
      };
    }

    const appendAssistantMessage = async ({ answerText, action }) =>
      repositories.conversations.appendMessage(conversationId, {
        role: "assistant",
        content: answerText,
        metadata: {
          source: "telegram",
          replyToTelegramUpdateId: request.telegramUpdateId,
          action,
        },
        userId: request.actor.id,
        workspaceId: requestWorkspaceId,
        createdAt: now(),
      });

    let storedUserMessage = userMessage;
    if (!userMessage) {
      storedUserMessage = await repositories.conversations.appendMessage(conversationId, {
        role: "user",
        content: request.text ?? "",
        metadata: {
          source: "telegram",
          intent: request.intent,
          telegramUpdateId: request.telegramUpdateId,
        },
        userId: request.actor.id,
        workspaceId: requestWorkspaceId,
        createdAt,
      });
    }

    const explicitMemory = extractExplicitMemory(request.text);
    if (explicitMemory) {
      if (isSensitiveMemoryContent(explicitMemory)) {
        const answerText =
          "Я не буду сохранять пароли, токены, ключи, данные карт или документы в память. Лучше не отправлять такие данные в чат.";
        await appendAssistantMessage({ answerText, action: "memory_rejected" });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "memory_rejected",
          },
          conversationId,
        };
      }

      const memory = {
        workspaceId: requestWorkspaceId,
        ownerUserId: request.actor.id,
        scope: memoryScopeForActor(request.actor),
        sensitivity: "normal",
        subjectType: "user_stated_fact",
        content: explicitMemory,
        sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        confidence: 1,
      };

      if (repositories.memories?.create && canStoreMemory(request.actor, memory)) {
        await repositories.memories.create(memory);
        const answerText = `Запомнил: ${explicitMemory}`;
        await appendAssistantMessage({ answerText, action: "memory_write" });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "memory_write",
          },
          conversationId,
        };
      }
    }

    const memories = repositories.memories
      ? await repositories.memories.listForActor({
          actorUserId: request.actor.id,
          workspaceId: requestWorkspaceId,
          limit: memoryContextLimit,
        })
      : [];

    if (isMemoryRecallRequest(request.text)) {
      const answerText = buildMemoryRecallAnswer({
        actor: request.actor,
        memories,
      });
      await appendAssistantMessage({ answerText, action: "memory_recall" });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "memory_recall",
        },
        conversationId,
      };
    }

    const response = await handleOrchestratorRequest(
      {
        ...request,
        memories,
        recentMessages: recentMessagesForPrompt(messages, request.telegramUpdateId),
      },
      { aiProvider },
    );
    const answer = response.answer ?? { text: defaultAnswer };
    const answerText = answer.text ?? defaultAnswer;

    await repositories.conversations.appendMessage(conversationId, {
      role: "assistant",
      content: answerText,
      metadata: {
        source: "telegram",
        replyToTelegramUpdateId: request.telegramUpdateId,
        agentProfile: response.agentProfile,
        modelProfile: response.modelProfile,
      },
      userId: request.actor.id,
      workspaceId: requestWorkspaceId,
      createdAt: now(),
    });

    return {
      ...response,
      answer: {
        ...answer,
        text: answerText,
      },
      conversationId,
    };
  };
}
