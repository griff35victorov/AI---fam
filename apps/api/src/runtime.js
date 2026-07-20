import { handleOrchestratorRequest } from "./orchestrator.js";

const defaultAnswer = "Принял. Задача обработана.";

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
    return { userMessage: null, assistantMessage: null };
  }

  const messages = await repositories.conversations.listMessages(conversationId);

  return {
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
    const createdAt = now();
    const { userMessage, assistantMessage } =
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

    if (!userMessage) {
      await repositories.conversations.appendMessage(conversationId, {
        role: "user",
        content: request.text ?? "",
        metadata: {
          source: "telegram",
          intent: request.intent,
          telegramUpdateId: request.telegramUpdateId,
        },
        createdAt,
      });
    }

    const memories = repositories.memories
      ? await repositories.memories.listForActor({
          actorUserId: request.actor.id,
          workspaceId: workspaceIdForRequest(request, workspaceId),
        })
      : [];

    const response = await handleOrchestratorRequest(
      {
        ...request,
        memories,
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
