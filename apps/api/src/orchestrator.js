import {
  requiresConfirmation,
  routeAgentProfile,
} from "../../../packages/domain/src/index.js";

export async function handleOrchestratorRequest(request) {
  const agentProfile = routeAgentProfile(request.actor, request.intent);
  const needsConfirmation = request.action
    ? requiresConfirmation(request.action)
    : false;

  return {
    agentProfile,
    requiresConfirmation: needsConfirmation,
    accepted: true,
  };
}
