const profileByTask = {
  routing: "cheap",
  reminder_summary: "cheap",
  memory_summary: "cheap",
  lesson_preparation: "standard",
  ege_explanation: "standard",
  english_practice: "standard",
  student_progress: "standard",
  gazebo_design: "strong",
  technical_analysis: "strong",
  complex_calculation: "strong",
  image_generation: "image",
};

const modelByProfile = {
  cheap: process.env.TIMEWEB_MODEL_CHEAP ?? "qwen-3.6-flash",
  standard: process.env.TIMEWEB_MODEL_STANDARD ?? "gpt-5.4-mini",
  strong: process.env.TIMEWEB_MODEL_STRONG ?? "gpt-5.4",
  image: process.env.TIMEWEB_MODEL_IMAGE ?? "gpt-image-2",
};

export function resolveModelProfile(taskType) {
  const profile = profileByTask[taskType] ?? "standard";
  return {
    profile,
    model: modelByProfile[profile],
  };
}

export function estimateTokenCostRub({
  inputTokens,
  outputTokens,
  inputRubPerMillion,
  outputRubPerMillion,
}) {
  const inputCost = (inputTokens / 1_000_000) * inputRubPerMillion;
  const outputCost = (outputTokens / 1_000_000) * outputRubPerMillion;
  return Number((inputCost + outputCost).toFixed(6));
}
