import { canAccessWorkspace } from "../../../packages/domain/src/index.js";

export function buildAllowedMemoryContext({ actor, memories, action = "read" }) {
  return memories
    .filter((memory) => memory.sensitivity !== "secret")
    .filter((memory) => {
      if (memory.sensitivity !== "student_personal_data") return true;
      return (
        (actor?.role === "teacher" || actor?.role === "system") &&
        memory.scope === "teacher_private"
      );
    })
    .filter((memory) => canAccessWorkspace(actor, memory.scope, action));
}

export function formatMemoryContext(memories) {
  if (memories.length === 0) return "";

  return memories
    .map((memory) => {
      const content = memory.summary ?? memory.content;
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
