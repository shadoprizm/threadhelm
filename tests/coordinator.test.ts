import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareCoordinatorRequest,
  type CoordinatorSnapshot,
} from "../src/coordinator.js";
import type { Task } from "../src/types.js";

function task(index: number, extras: Partial<Task> = {}): Task {
  return {
    key: `local:task-${index}`,
    hostId: "local",
    id: `task-${index}`,
    title: `Task ${index}`,
    cwd: "/workspace/project",
    status: "idle",
    owned: false,
    updatedAt: index,
    observedAt: index,
    messages: [],
    latest: { id: `latest-${index}`, role: "assistant", text: "x".repeat(2000) },
    ...extras,
  };
}

function snapshot(): CoordinatorSnapshot {
  return {
    hosts: [
      { id: "local", name: "Local", codex: "codex", python: "python3" },
    ],
    projects: [
      {
        id: "project",
        hostId: "local",
        name: "Project",
        roots: ["/workspace/project"],
        source: "codex",
      },
    ],
    tasks: [
      task(0, {
        title: "Priority task",
        status: "running",
        watched: true,
      }),
      ...Array.from({ length: 299 }, (_, index) => task(index + 1)),
    ],
    inboxActions: Array.from({ length: 300 }, (_, index) => ({
      id: `action-${index}`,
      task_key: `local:task-${index}`,
      kind: index === 0 ? "approval" : "completion",
      status: "open",
      title: `Action ${index}`,
      body: "y".repeat(2500),
      updated_at: index,
      ...(index === 0
        ? { payload: { params: { command: "test", detail: "z".repeat(8000) } } }
        : {}),
    })),
    history: Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      body: {
        answer: `Conversation ${index}: ${"h".repeat(18000)}`,
        actions: [
          {
            id: `proposal-${index}`,
            type: "send",
            reason: "Continue safely.",
            taskKey: "local:task-0",
            prompt: "This prompt is intentionally not replayed into history.",
          },
        ],
      },
    })),
  };
}

test("the coordinator defaults to Terra xhigh with broad but bounded evidence", () => {
  const request = prepareCoordinatorRequest("Review the workspace.", snapshot());
  assert.equal(request.model, "gpt-5.6-terra");
  assert.equal(request.effort, "xhigh");
  assert.equal(request.maxInputChars, 800000);
  assert.ok(request.prompt.length <= request.maxInputChars);
  assert.ok(request.context.tasks.included < request.context.tasks.available);
  assert.ok(request.context.inbox.included < request.context.inbox.available);
  assert.match(request.prompt, /Priority task/);
  assert.match(request.prompt, /EVIDENCE COVERAGE/);
  assert.doesNotMatch(request.prompt, /intentionally not replayed/);
});

test("the context safety rail is a high-water mark even with oversized evidence", () => {
  const request = prepareCoordinatorRequest("Review the workspace.", snapshot(), {
    maxInputChars: 50000,
  });
  assert.equal(request.maxInputChars, 100000);
  assert.ok(request.prompt.length <= request.maxInputChars);
  assert.ok(request.context.history.included > 0);
  assert.ok(request.context.tasks.included > 0);
});
