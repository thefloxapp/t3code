import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  automaticDeliveryOrigin,
  automaticDigest,
  isFoldableAutomaticMessage,
} from "./AutomaticDelivery.ts";

const stamp = (number: number) => ({
  host: "github.com",
  repository: "acme/app",
  number,
  watchStartedAt: "2026-11-23T10:00:00.000Z",
  headSha: null,
});
const wake = (...numbers: [number, ...Array<number>]) => ({
  createdBy: "agent",
  creationSource: "server",
  notification: {
    source: {
      kind: "monitor",
      pullRequest: stamp(numbers[0]),
      ...(numbers.length > 1 ? { otherPullRequests: numbers.slice(1).map(stamp) } : {}),
    },
    outcome: "updated",
    summary: "update",
  },
});

describe("automatic delivery origin", () => {
  it.each([
    ["pull request wake", wake(7), { kind: "pull_request", key: "github.com/acme/app#7" }],
    ["wake covering two pull requests", wake(7, 8), { kind: "pull_request", key: null }],
    [
      "two updates merged for one pull request",
      wake(7, 7),
      { kind: "pull_request", key: "github.com/acme/app#7" },
    ],
    [
      "scheduled task a user created",
      { createdBy: "user", creationSource: "web", scheduledTaskId: "task:1" },
      { kind: "scheduled_task", key: "task:1" },
    ],
    [
      "agent send",
      { createdBy: "agent", creationSource: "mcp", senderThreadId: "thread:worker" },
      { kind: "agent_send", key: "thread:worker" },
    ],
    ["user message", { createdBy: "user", creationSource: "web" }, undefined],
    ["agent send with no sender", { createdBy: "agent", creationSource: "mcp" }, undefined],
    ["provider background notice", { ...wake(7), creationSource: "provider" }, undefined],
    [
      "delegated completion",
      {
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: { parentRunId: "run:1", generation: 1, taskIds: [] },
      },
      undefined,
    ],
  ] as const)("%s", (_, message, origin) => {
    expect(automaticDeliveryOrigin(message as never)).toEqual(origin);
  });
});

describe("foldable automatic messages", () => {
  const plain = {
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: "thread:worker",
    text: "Tests pass.",
    attachments: [],
  };
  it.each([
    ["plain report", plain, {}, true],
    ["command text", { ...plain, text: "/compact" }, {}, false],
    ["attachment", { ...plain, attachments: [{ id: "file" }] }, {}, false],
    ["fresh context", plain, { freshContext: true }, false],
    ["held", plain, { queueHeld: true }, false],
    ["delegated follow-up", plain, { delegatedTaskId: "node:task" }, false],
  ] as const)("%s", (_, message, run, foldable) => {
    expect(isFoldableAutomaticMessage(message as never, run as never)).toBe(foldable);
  });
});

describe("automatic digest", () => {
  const at = DateTime.makeUnsafe("2026-11-23T10:00:00.000Z");
  it("lifts the sections of an earlier digest instead of nesting it", () => {
    const first = automaticDigest([
      { label: "A", at, text: "one" },
      { label: "B", at, text: "two" },
    ]);
    const second = automaticDigest([
      { label: "C", at, text: first.text, digestMessages: first.messages },
      { label: "D", at, text: "three" },
    ]);
    expect(second.messages).toBe(3);
    expect(second.text.match(/automatic messages arrived/g)).toHaveLength(1);
    expect(second.text).toContain("--- A, 2026-11-23T10:00:00.000Z ---\none");
    expect(second.text).toContain("--- D, 2026-11-23T10:00:00.000Z ---\nthree");
  });

  it("keeps an edited digest whole", () => {
    const digest = automaticDigest([
      { label: "Edited", at, text: "My own words", digestMessages: 2 },
      { label: "B", at, text: "two" },
    ]);
    expect(digest.messages).toBe(2);
    expect(digest.text).toContain("--- Edited, 2026-11-23T10:00:00.000Z ---\nMy own words");
  });
});
