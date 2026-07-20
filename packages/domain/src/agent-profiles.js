const ownerIntentRoutes = {
  household: "owner_assistant",
  technical_question: "owner_assistant",
  product_search: "shopping_assistant",
  calculation: "owner_assistant",
  gazebo_design: "design_assistant",
  calendar: "scheduler",
  reminder: "scheduler",
};

const childIntentRoutes = {
  school_help: "daughter_tutor",
  ege_preparation: "daughter_tutor",
  english_practice: "daughter_english_coach",
  household: "owner_assistant",
  reminder: "scheduler",
};

const teacherIntentRoutes = {
  lesson_preparation: "teacher_methodologist",
  material_search: "materials_librarian",
  student_schedule: "teacher_secretary",
  student_progress: "teacher_secretary",
  message_draft: "communication_assistant",
  reminder: "scheduler",
};

export function routeAgentProfile(actor, intent) {
  if (actor?.role === "owner") return ownerIntentRoutes[intent] ?? "family_dispatcher";
  if (actor?.role === "family_child") return childIntentRoutes[intent] ?? "daughter_tutor";
  if (actor?.role === "teacher") return teacherIntentRoutes[intent] ?? "teacher_secretary";
  return "family_dispatcher";
}
