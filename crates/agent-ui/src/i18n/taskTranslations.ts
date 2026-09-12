export const TASK_TRANSLATIONS = {
  "zh-CN": {
    "chat.taskProgress.title": "Task progress",
    "chat.taskProgress.step": "Step {current} of {total}",
    "chat.taskProgress.running": "Running",
    "chat.taskProgress.pending": "Pending",
    "chat.taskProgress.paused": "Paused or interrupted",
    "chat.taskProgress.completed": "All completed",
    "chat.taskProgress.taskPaused": "Paused",
    "chat.taskProgress.taskCompleted": "Completed",
    "chat.taskProgress.completedCount": "completed",
    "settings.builtinTool.task_create.name": "Create Task",
    "settings.builtinTool.task_create.desc": "Add one task to the current run",
    "settings.builtinTool.task_create.detail":
      "Create a durable task with a stable numeric ID; chat sessions only.",
    "settings.builtinTool.task_update.name": "Update Task",
    "settings.builtinTool.task_update.desc": "Update one task by stable ID",
    "settings.builtinTool.task_update.detail":
      "Update task status or content without replacing the task list; chat sessions only.",
    "settings.builtinTool.task_list.name": "List Tasks",
    "settings.builtinTool.task_list.desc": "Read the current run's complete task list",
    "settings.builtinTool.task_list.detail":
      "Return the authoritative task snapshot and stable IDs for the current run; chat sessions only.",
  },
  "en-US": {
    "chat.taskProgress.title": "Task progress",
    "chat.taskProgress.step": "Step {current} of {total}",
    "chat.taskProgress.running": "Running",
    "chat.taskProgress.pending": "Pending",
    "chat.taskProgress.paused": "Paused or interrupted",
    "chat.taskProgress.completed": "All completed",
    "chat.taskProgress.taskPaused": "Paused",
    "chat.taskProgress.taskCompleted": "Completed",
    "chat.taskProgress.completedCount": "completed",
    "settings.builtinTool.task_create.name": "Create Task",
    "settings.builtinTool.task_create.desc": "Add one task to the current run",
    "settings.builtinTool.task_create.detail":
      "Create a durable task with a stable numeric ID; chat sessions only.",
    "settings.builtinTool.task_update.name": "Update Task",
    "settings.builtinTool.task_update.desc": "Update one task by stable ID",
    "settings.builtinTool.task_update.detail":
      "Update task status or content without replacing the task list; chat sessions only.",
    "settings.builtinTool.task_list.name": "List Tasks",
    "settings.builtinTool.task_list.desc": "Read the current run's complete task list",
    "settings.builtinTool.task_list.detail":
      "Return the authoritative task snapshot and stable IDs for the current run; chat sessions only.",
  },
} as const satisfies Record<"zh-CN" | "en-US", Record<string, string>>;
