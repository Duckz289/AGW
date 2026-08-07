import { z } from "zod";

/**
 * Phase 2A minimum event type set (CURRENT_TASK.md). Checker/finding/
 * report event types are explicitly out of scope for this milestone.
 */
export const TimelineEventTypeSchema = z.enum([
  "run_started",
  "run_finished",
  "action_started",
  "action_finished",
  "verification",
  "console",
  "runtime_error",
  "network_request",
  "network_response",
  "network_failed",
  "network_finished",
  "screenshot"
]);

export type TimelineEventType = z.infer<typeof TimelineEventTypeSchema>;

// --- payload schemas ----------------------------------------------------

export const RunStartedPayloadSchema = z.object({
  runId: z.string().min(1),
  flowName: z.string().min(1),
  startUrl: z.string().min(1),
  startedAt: z.string().min(1)
});

/**
 * Duplicated from `FlowRunStatus` (src/engine/flow-runner.ts) rather than
 * imported, to avoid a circular import (flow-runner -> timeline/store ->
 * timeline/events -> flow-runner). Kept structurally identical on
 * purpose: the only place this schema is fed a value is
 * `finalize()` in flow-runner.ts, passing a real `FlowRunStatus`; if the
 * two ever drift, that call site fails to typecheck rather than silently
 * validating the wrong set of statuses at runtime.
 */
export const RunFinishedStatusSchema = z.enum([
  "passed",
  "failed",
  "config_error",
  "environment_error",
  "internal_error"
]);

export const RunFinishedPayloadSchema = z.object({
  status: RunFinishedStatusSchema,
  completedSteps: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative()
});

export const ActionStartedPayloadSchema = z.object({
  actionId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  stepType: z.string().min(1)
});

export const ActionFinishedPayloadSchema = z.object({
  actionId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  stepType: z.string().min(1),
  ok: z.boolean(),
  durationMs: z.number().nonnegative()
});

export const VerificationPayloadSchema = z.object({
  passed: z.boolean(),
  kind: z.string().min(1),
  elapsedMs: z.number().nonnegative(),
  observed: z.string(),
  errorCode: z.string().optional()
});

export const ConsoleLocationSchema = z.object({
  url: z.string().optional(),
  lineNumber: z.number().int().optional(),
  columnNumber: z.number().int().optional()
});

export const ConsolePayloadSchema = z.object({
  level: z.string().min(1),
  text: z.string(),
  location: ConsoleLocationSchema.optional()
});

export const RuntimeErrorPayloadSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
  stack: z.string().optional()
});

export const NetworkRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  method: z.string().min(1),
  url: z.string().min(1),
  resourceType: z.string().min(1)
});

export const NetworkResponsePayloadSchema = z.object({
  requestId: z.string().min(1),
  url: z.string().min(1),
  status: z.number().int(),
  statusText: z.string().optional(),
  contentType: z.string().optional()
});

export const NetworkFailedPayloadSchema = z.object({
  requestId: z.string().min(1),
  url: z.string().min(1),
  method: z.string().min(1),
  failureText: z.string().optional()
});

export const NetworkFinishedPayloadSchema = z.object({
  requestId: z.string().min(1),
  url: z.string().min(1),
  method: z.string().min(1),
  status: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional()
});

export const ScreenshotReasonSchema = z.enum(["action_failed", "verification_failed"]);

export const ScreenshotPayloadSchema = z.object({
  path: z.string().min(1),
  reason: ScreenshotReasonSchema
});

// --- envelope -------------------------------------------------------------

const BaseEnvelopeSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().positive(),
  runId: z.string().min(1),
  timestampWallMs: z.number(),
  timestampMonoMs: z.number(),
  actionId: z.string().min(1).optional()
});

export const RunStartedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("run_started"),
  payload: RunStartedPayloadSchema
});

export const RunFinishedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("run_finished"),
  payload: RunFinishedPayloadSchema
});

export const ActionStartedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("action_started"),
  payload: ActionStartedPayloadSchema
});

export const ActionFinishedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("action_finished"),
  payload: ActionFinishedPayloadSchema
});

export const VerificationEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("verification"),
  payload: VerificationPayloadSchema
});

export const ConsoleEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("console"),
  payload: ConsolePayloadSchema
});

export const RuntimeErrorEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("runtime_error"),
  payload: RuntimeErrorPayloadSchema
});

export const NetworkRequestEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("network_request"),
  payload: NetworkRequestPayloadSchema
});

export const NetworkResponseEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("network_response"),
  payload: NetworkResponsePayloadSchema
});

export const NetworkFailedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("network_failed"),
  payload: NetworkFailedPayloadSchema
});

export const NetworkFinishedEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("network_finished"),
  payload: NetworkFinishedPayloadSchema
});

export const ScreenshotEventSchema = BaseEnvelopeSchema.extend({
  type: z.literal("screenshot"),
  payload: ScreenshotPayloadSchema
});

export const TimelineEventSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunFinishedEventSchema,
  ActionStartedEventSchema,
  ActionFinishedEventSchema,
  VerificationEventSchema,
  ConsoleEventSchema,
  RuntimeErrorEventSchema,
  NetworkRequestEventSchema,
  NetworkResponseEventSchema,
  NetworkFailedEventSchema,
  NetworkFinishedEventSchema,
  ScreenshotEventSchema
]);

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

/**
 * Documentation-oriented generic shape matching CURRENT_TASK.md's required
 * envelope. `TimelineEventSchema` (a discriminated union keyed by `type`)
 * is the actual runtime-validated source of truth; every member of that
 * union is structurally an instance of this generic for its own payload
 * type.
 */
export interface TimelineEnvelope<T> {
  version: 1;
  seq: number;
  runId: string;
  timestampWallMs: number;
  timestampMonoMs: number;
  type: TimelineEventType;
  actionId?: string;
  payload: T;
}

/** The concrete payload type for a given event type, e.g. `PayloadForType<"console">`. */
export type PayloadForType<T extends TimelineEventType> = Extract<TimelineEvent, { type: T }>["payload"];
