import { z } from "zod";
import { SemanticTargetSchema } from "./action.ts";

/**
 * Typed, structured expectations only — no free-text assertions, per
 * MVP_PLAN.MD §6.5 and AGENT.MD's verification-engine determinism rule.
 *
 * `url_matches.pattern` is matched as a plain substring/path match against
 * the current page URL (see src/engine/verification.ts), not as a regular
 * expression: Phase 1A's flows are local, trusted JSON files, but arbitrary
 * regex execution is still avoided in favor of the simplest sufficient
 * mechanism.
 */
export const ExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url_matches"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("element_visible"), role: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal("element_hidden"), role: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal("text_present"), text: z.string().min(1) })
]);

export type Expectation = z.infer<typeof ExpectationSchema>;

const StepTimeoutSchema = z.number().int().positive().max(60_000).optional();

/**
 * Phase 1A supports exactly four step types (navigate, fill, click, expect)
 * per CURRENT_TASK.md. select/scroll/press/wait/branching/loops/variables
 * are explicitly out of scope and are not needed by the reference flow.
 *
 * `expected` is optional on navigate/fill/click (an action step may assert
 * its immediate result, matching the MVP_PLAN.MD §4.1 example flow) and
 * required on `expect` (a pure verification step with no browser action).
 */
export const NavigateStepSchema = z.object({
  type: z.literal("navigate"),
  url: z.string().min(1),
  timeoutMs: StepTimeoutSchema,
  expected: ExpectationSchema.optional()
});

export const FillStepSchema = z.object({
  type: z.literal("fill"),
  target: SemanticTargetSchema,
  value: z.string(),
  timeoutMs: StepTimeoutSchema,
  expected: ExpectationSchema.optional()
});

export const ClickStepSchema = z.object({
  type: z.literal("click"),
  target: SemanticTargetSchema,
  timeoutMs: StepTimeoutSchema,
  expected: ExpectationSchema.optional()
});

export const ExpectStepSchema = z.object({
  type: z.literal("expect"),
  expected: ExpectationSchema,
  timeoutMs: StepTimeoutSchema
});

export const FlowStepSchema = z.discriminatedUnion("type", [
  NavigateStepSchema,
  FillStepSchema,
  ClickStepSchema,
  ExpectStepSchema
]);

export type FlowStep = z.infer<typeof FlowStepSchema>;

/**
 * Minimal, explicit declaration surface for Phase 2B checkers that cannot
 * be inferred from generic timeline evidence alone (CURRENT_TASK.md:
 * "Extend flow/test configuration minimally so a fixture can declare a
 * loading indicator or state expectation" / "This checker MUST require
 * explicit configured UI error expectation or fixture metadata"). Both
 * fields are optional and the corresponding checker (ST-INFINITE-LOADING,
 * FM-SERVER-ERROR-NOT-SHOWN) simply does not run when its own field is
 * absent — no scanning arbitrary page text, no guessing.
 */
export const CheckerTargetSchema = z.object({
  role: z.string().min(1),
  name: z.string().min(1)
});

export type CheckerTarget = z.infer<typeof CheckerTargetSchema>;

export const FlowChecksConfigSchema = z.object({
  loadingIndicator: CheckerTargetSchema.optional(),
  errorIndicator: CheckerTargetSchema.optional()
});

export type FlowChecksConfig = z.infer<typeof FlowChecksConfigSchema>;

export const ScriptedFlowSchema = z.object({
  name: z.string().min(1),
  startUrl: z.string().min(1),
  steps: z.array(FlowStepSchema).min(1),
  checks: FlowChecksConfigSchema.optional()
});

export type ScriptedFlow = z.infer<typeof ScriptedFlowSchema>;
