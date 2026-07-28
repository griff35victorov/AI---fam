import { canAccessWorkspace } from "../../../packages/domain/src/index.js";

function memoryContentForContext(memory) {
  return String(memory?.summary ?? memory?.content ?? "").trim();
}

function canonicalMemoryContent(content) {
  return String(content ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ");
}

export function memorySemanticKey(memory) {
  const content = canonicalMemoryContent(memoryContentForContext(memory));
  if (!content) return memory?.id ? `id:${memory.id}` : "";
  return [
    memory?.workspaceId ?? "",
    memory?.ownerUserId ?? "",
    memory?.scope ?? "",
    content,
  ].join("|");
}

export function dedupeMemoriesBySemanticContent(memories) {
  const seen = new Set();
  const deduped = [];

  for (const memory of memories ?? []) {
    const key = memorySemanticKey(memory);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(memory);
  }

  return deduped;
}

export function buildAllowedMemoryContext({ actor, memories, action = "read" }) {
  const allowedMemories = (memories ?? [])
    .filter((memory) => memory.sensitivity !== "secret")
    .filter((memory) => {
      if (memory.sensitivity !== "student_personal_data") return true;
      return (
        (actor?.role === "teacher" || actor?.role === "system") &&
        memory.scope === "teacher_private"
      );
    })
    .filter((memory) => canAccessWorkspace(actor, memory.scope, action));

  return dedupeMemoriesBySemanticContent(allowedMemories);
}

export function formatMemoryContext(memories) {
  if (memories.length === 0) return "";

  return memories
    .map((memory) => {
      const content = memoryContentForContext(memory);
      return `- [${memory.scope}/${memory.subjectType}] ${content}`;
    })
    .join("\n");
}

export function buildAllowedMaterialContext({ actor, materials, action = "read" }) {
  return materials
    .filter((material) => material.sensitivity !== "secret")
    .filter((material) => canAccessWorkspace(actor, material.scope ?? "family", action));
}

export function formatMaterialContext(materials) {
  if (materials.length === 0) return "";

  return materials
    .map((material) => {
      const title = material.materialTitle ?? material.title ?? "Material";
      return `- [${material.scope}/${title}] ${material.content}`;
    })
    .join("\n");
}
