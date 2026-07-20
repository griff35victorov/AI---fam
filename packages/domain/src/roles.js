export const roles = Object.freeze({
  owner: "owner",
  teacher: "teacher",
  familyChild: "family_child",
  system: "system",
});

export const workspaces = Object.freeze({
  family: "family",
  childLearning: "child_learning",
  teacherPrivate: "teacher_private",
});

const accessMatrix = {
  owner: {
    family: ["read", "write", "admin"],
    child_learning: ["read", "write", "admin"],
    teacher_private: [],
  },
  teacher: {
    family: ["read", "write"],
    child_learning: ["read"],
    teacher_private: ["read", "write", "admin"],
  },
  family_child: {
    family: ["read", "write"],
    child_learning: ["read", "write"],
    teacher_private: [],
  },
  system: {
    family: ["read", "write"],
    child_learning: ["read", "write"],
    teacher_private: ["read", "write"],
  },
};

export function canAccessWorkspace(actor, workspace, action = "read") {
  const roleAccess = accessMatrix[actor?.role] ?? {};
  return (roleAccess[workspace] ?? []).includes(action);
}
