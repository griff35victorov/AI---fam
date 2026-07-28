import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAllowedMemoryContext,
  formatMemoryContext,
} from "../src/context.js";

const memories = [
  {
    id: "family-pref",
    scope: "family",
    sensitivity: "normal",
    subjectType: "preference",
    content: "Family prefers concise answers in Russian.",
  },
  {
    id: "child-progress",
    scope: "child_learning",
    sensitivity: "normal",
    subjectType: "study_progress",
    content: "Daughter needs more practice with English tenses.",
  },
  {
    id: "student-private",
    scope: "teacher_private",
    sensitivity: "student_personal_data",
    subjectType: "student",
    content: "Student Ivan has a lesson at 18:00.",
  },
  {
    id: "secret",
    scope: "family",
    sensitivity: "secret",
    subjectType: "credential",
    content: "API token is 123.",
  },
  {
    id: "mis-scoped-student-data",
    scope: "family",
    sensitivity: "student_personal_data",
    subjectType: "student",
    content: "Student Maria phone is +79990000000.",
  },
];

test("owner context excludes teacher private student data and secrets", () => {
  const context = buildAllowedMemoryContext({
    actor: { role: "owner" },
    memories,
    action: "read",
  });

  assert.deepEqual(
    context.map((memory) => memory.id),
    ["family-pref", "child-progress"],
  );
});

test("child context excludes teacher private data and secrets", () => {
  const context = buildAllowedMemoryContext({
    actor: { role: "family_child" },
    memories,
    action: "read",
  });

  assert.deepEqual(
    context.map((memory) => memory.id),
    ["family-pref", "child-progress"],
  );
});

test("teacher context includes teacher private student data but excludes secrets", () => {
  const context = buildAllowedMemoryContext({
    actor: { role: "teacher" },
    memories,
    action: "read",
  });

  assert.deepEqual(
    context.map((memory) => memory.id),
    ["family-pref", "child-progress", "student-private"],
  );
});

test("formatted owner prompt does not include private student data", () => {
  const promptContext = formatMemoryContext(
    buildAllowedMemoryContext({
      actor: { role: "owner" },
      memories,
      action: "read",
    }),
  );

  assert.match(promptContext, /Family prefers concise answers/);
  assert.doesNotMatch(promptContext, /Student Ivan/);
  assert.doesNotMatch(promptContext, /Student Maria/);
  assert.doesNotMatch(promptContext, /18:00/);
  assert.doesNotMatch(promptContext, /\+79990000000/);
  assert.doesNotMatch(promptContext, /API token/);
});
