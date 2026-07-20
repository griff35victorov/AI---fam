const confirmationActions = new Set([
  "send_external_message",
  "delete_memory",
  "delete_student",
  "delete_material",
  "change_other_user_schedule",
  "use_strong_model",
  "export_student_data",
  "purchase_item",
  "book_service",
]);

export function requiresConfirmation(action) {
  return confirmationActions.has(action);
}

export function canStoreMemory(actor, memory) {
  if (!actor?.role || !memory) return false;

  if (memory.sensitivity === "secret") return false;

  if (memory.sensitivity === "student_personal_data") {
    return actor.role === "teacher" && memory.scope === "teacher_private";
  }

  if (memory.scope === "teacher_private") {
    return actor.role === "teacher" || actor.role === "system";
  }

  if (memory.scope === "child_learning") {
    return actor.role === "family_child" || actor.role === "owner" || actor.role === "system";
  }

  if (memory.scope === "family") {
    return actor.role === "owner" || actor.role === "teacher" || actor.role === "family_child" || actor.role === "system";
  }

  return false;
}
