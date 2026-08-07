import { z } from "zod";
import { TimelineEventTypeSchema } from "../timeline/events.ts";

/**
 * Points back at exact timeline evidence by `seq` — never a copy of the
 * raw event payload (CURRENT_TASK.md: "Do not embed full timeline
 * payloads into each finding"). `requestId`/`screenshotPath` are present
 * only when the referenced event actually carries one.
 */
export const EvidenceRefSchema = z.object({
  seq: z.number().int().positive(),
  type: TimelineEventTypeSchema,
  actionId: z.string().min(1).optional(),
  requestId: z.string().min(1).optional(),
  screenshotPath: z.string().min(1).optional()
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/**
 * Deliberately minimal — no generated Playwright test code, no claim of
 * verified reproduction beyond "this flow, run, produced this evidence"
 * (CURRENT_TASK.md: "Do not claim verified reproduction unless the flow
 * actually executed").
 */
export const ReproductionRefSchema = z.object({
  flowName: z.string().min(1),
  failedStepIndex: z.number().int().nonnegative().optional(),
  failedStepType: z.string().min(1).optional()
});

export type ReproductionRef = z.infer<typeof ReproductionRefSchema>;

/** Matches CheckerStatus (src/checkers/types.ts) exactly — the checker `status` maps directly to `classification`, no severity/confidence framework yet. */
export const FindingClassificationSchema = z.enum(["confirmed", "likely", "warning"]);
export type FindingClassification = z.infer<typeof FindingClassificationSchema>;

export const FindingCategorySchema = z.enum([
  "runtime",
  "network",
  "state",
  "form",
  "navigation",
  "accessibility",
  "responsive",
  "performance",
  "other"
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

/** Arbitrary JSON value, for Finding.metadata. Not currently populated by any Phase 2B checker — the schema exists so a future checker can attach structured extras without a Finding shape change. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)])
);

export const FindingSchema = z.object({
  id: z.string().min(1),
  ruleId: z.string().min(1),
  title: z.string().min(1),
  classification: FindingClassificationSchema,
  category: FindingCategorySchema,
  summary: z.string(),
  observed: z.string(),
  expected: z.string(),
  actionId: z.string().min(1).optional(),
  evidence: z.array(EvidenceRefSchema),
  reproduction: ReproductionRefSchema.optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional()
});

export type Finding = z.infer<typeof FindingSchema>;
