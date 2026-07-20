import assert from "node:assert/strict";
import test from "node:test";

import {
  canAccessWorkspace,
  canStoreMemory,
  requiresConfirmation,
  routeAgentProfile,
} from "../src/index.js";

test("teacher private workspace is only available to teacher by default", () => {
  assert.equal(canAccessWorkspace({ role: "teacher" }, "teacher_private", "read"), true);
  assert.equal(canAccessWorkspace({ role: "owner" }, "teacher_private", "read"), false);
  assert.equal(canAccessWorkspace({ role: "family_child" }, "teacher_private", "read"), false);
});

test("child can access child learning but not teacher student data", () => {
  assert.equal(canAccessWorkspace({ role: "family_child" }, "child_learning", "read"), true);
  assert.equal(canAccessWorkspace({ role: "family_child" }, "teacher_private", "read"), false);
});

test("student personal data cannot be stored in shared family memory", () => {
  const memory = {
    scope: "family",
    sensitivity: "student_personal_data",
    subjectType: "student",
  };

  assert.equal(canStoreMemory({ role: "teacher" }, memory), false);
});

test("stable teaching preferences can be stored in teacher memory", () => {
  const memory = {
    scope: "teacher_private",
    sensitivity: "normal",
    subjectType: "teaching_style",
  };

  assert.equal(canStoreMemory({ role: "teacher" }, memory), true);
});

test("external actions require confirmation", () => {
  assert.equal(requiresConfirmation("send_external_message"), true);
  assert.equal(requiresConfirmation("delete_student"), true);
  assert.equal(requiresConfirmation("use_strong_model"), true);
  assert.equal(requiresConfirmation("draft_lesson_plan"), false);
});

test("router selects specialist profile by user role and intent", () => {
  assert.equal(routeAgentProfile({ role: "owner" }, "gazebo_design"), "design_assistant");
  assert.equal(routeAgentProfile({ role: "family_child" }, "english_practice"), "daughter_english_coach");
  assert.equal(routeAgentProfile({ role: "teacher" }, "lesson_preparation"), "teacher_methodologist");
  assert.equal(routeAgentProfile({ role: "teacher" }, "student_schedule"), "teacher_secretary");
});
