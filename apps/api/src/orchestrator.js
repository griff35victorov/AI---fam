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

export async function handleOrchestratorRequest(request, dependencies = {}) {
  const agentProfile = routeAgentProfile(request.actor, request.intent);
  const needsConfirmation = request.action
    ? requiresConfirmation(request.action)
    : false;
  const taskType = taskTypeByIntent[request.intent] ?? "routing";
  const modelProfile = resolveModelProfile(taskType);
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
