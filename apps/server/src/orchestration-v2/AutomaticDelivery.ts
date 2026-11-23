import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  ThreadPullRequestKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Where a queued message nobody typed came from. Keyed origins keep one waiting message per
 * key, so a newer pull request update, scheduled run, or report from the same thread replaces it.
 */
export type AutomaticDeliveryOrigin =
  | { readonly kind: "pull_request"; readonly key: string | null }
  | { readonly kind: "scheduled_task"; readonly key: string }
  | { readonly kind: "agent_send"; readonly key: string }
  | { readonly kind: "digest"; readonly key: null };

type OriginFields = Pick<
  OrchestrationV2ConversationMessage,
  | "createdBy"
  | "creationSource"
  | "notification"
  | "scheduledTaskId"
  | "senderThreadId"
  | "linkedSender"
  | "delegatedCompletion"
  | "automaticDigest"
>;

/** Stamps are normalized when the watch sync dispatches them. */
const pullRequestKey = (key: ThreadPullRequestKey) => `${key.host}/${key.repository}#${key.number}`;

export function automaticDeliveryOrigin(
  message: OriginFields,
): AutomaticDeliveryOrigin | undefined {
  if (message.delegatedCompletion !== undefined) return undefined;
  if (message.automaticDigest !== undefined) return { kind: "digest", key: null };
  const source = message.notification?.source;
  if (source !== undefined) {
    if (
      source.kind !== "monitor" ||
      source.pullRequest === undefined ||
      message.creationSource !== "server"
    ) {
      return undefined;
    }
    return {
      kind: "pull_request",
      key: (source.otherPullRequests?.length ?? 0) > 0 ? null : pullRequestKey(source.pullRequest),
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return { kind: "scheduled_task", key: message.scheduledTaskId };
  }
  if (message.createdBy !== "agent") return undefined;
  if (message.linkedSender !== undefined) {
    return {
      kind: "agent_send",
      key: `${message.linkedSender.environmentId}/${message.linkedSender.threadId}`,
    };
  }
  return message.senderThreadId === undefined
    ? undefined
    : { kind: "agent_send", key: message.senderThreadId };
}

/** Text the provider reads as a command, which a digest would turn into prose. */
const LEADING_COMMAND = /^\s*[/$]/u;

/** An automatic message that can share a turn with others without changing how it runs. */
export function isFoldableAutomaticMessage(
  message: OriginFields &
    Pick<
      OrchestrationV2ConversationMessage,
      "text" | "attachments" | "context" | "idleCompaction" | "workflowScript"
    >,
  run: Pick<
    OrchestrationV2Run,
    | "freshContext"
    | "queueHeld"
    | "delegatedTaskId"
    | "restartContinuationOfRunId"
    | "manualContinuationOfRunId"
    | "usageLimitContinuationOfRunId"
    | "steerWhenReadyRunId"
    | "sourcePlanRef"
  >,
): boolean {
  return (
    automaticDeliveryOrigin(message) !== undefined &&
    run.freshContext !== true &&
    run.queueHeld !== true &&
    // Cancelling these would also resolve the task, continuation, or plan the run carries.
    run.delegatedTaskId === undefined &&
    run.restartContinuationOfRunId === undefined &&
    run.manualContinuationOfRunId === undefined &&
    run.usageLimitContinuationOfRunId === undefined &&
    run.steerWhenReadyRunId === undefined &&
    run.sourcePlanRef === undefined &&
    message.attachments.length === 0 &&
    (message.context?.records.length ?? 0) === 0 &&
    message.idleCompaction === undefined &&
    message.workflowScript !== true &&
    !LEADING_COMMAND.test(message.text)
  );
}

export interface AutomaticDigestItem {
  readonly label: string;
  readonly at: DateTime.Utc;
  readonly text: string;
  /** Set when the item is itself a digest, whose sections are lifted out rather than nested. */
  readonly digestMessages?: number | undefined;
}

const DIGEST_HEADER_START = "[T3 Code: ";
const DIGEST_HEADER_END =
  " automatic messages arrived while this thread was busy. They are delivered together in this one turn, oldest first. The user did not type any of them.]";
const digestHeader = (messages: number) => `${DIGEST_HEADER_START}${messages}${DIGEST_HEADER_END}`;

/** The sections of a digest, or undefined when its text no longer starts with the header (edited). */
function digestBody(text: string): string | undefined {
  const bodyStart = text.indexOf("\n\n");
  const header = bodyStart === -1 ? text : text.slice(0, bodyStart);
  return header.startsWith(DIGEST_HEADER_START) && header.endsWith(DIGEST_HEADER_END)
    ? text.slice(bodyStart + 2)
    : undefined;
}

export function automaticDigest(items: ReadonlyArray<AutomaticDigestItem>): {
  readonly text: string;
  readonly messages: number;
} {
  let messages = 0;
  const sections = items.map((item) => {
    const body = item.digestMessages === undefined ? undefined : digestBody(item.text);
    if (item.digestMessages !== undefined && body !== undefined) {
      messages += item.digestMessages;
      return body;
    }
    messages += 1;
    return `--- ${item.label}, ${DateTime.formatIso(item.at)} ---\n${item.text}`;
  });
  return { text: [digestHeader(messages), ...sections].join("\n\n"), messages };
}

export function automaticDigestLabel(
  message: OriginFields,
  senderTitle: string | undefined,
): string {
  const origin = automaticDeliveryOrigin(message);
  if (origin?.kind === "pull_request") return "Pull request watch";
  if (origin?.kind === "scheduled_task") return `Scheduled task ${JSON.stringify(origin.key)}`;
  if (message.linkedSender !== undefined) {
    return `From the agent in T3 thread ${JSON.stringify(message.linkedSender.title)} (${message.linkedSender.threadId}) on linked environment ${message.linkedSender.environmentId}`;
  }
  if (message.senderThreadId !== undefined) {
    return senderTitle === undefined
      ? `From the agent in T3 thread ${message.senderThreadId}`
      : `From the agent in T3 thread ${JSON.stringify(senderTitle)} (${message.senderThreadId})`;
  }
  return "Automatic message";
}
