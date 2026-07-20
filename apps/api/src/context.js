import { canAccessWorkspace } from "../../../packages/domain/src/index.js";

export function buildAllowedMemoryContext({ actor, memories, action = "read" }) {
  return memories
    .filter((memory) => memory.sensitivity !== "secret")
    .filter((memory) => canAccessWorkspace(actor, memory.scope, action));
}

export function formatMemoryContext(memories) {
  if (memories.length === 0) return "";

  return memories
    .map((memory) => `- [${memory.scope}/${memory.subjectType}] ${memory.content}`)
    .join("\n");
}
