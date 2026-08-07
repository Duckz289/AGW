import { z } from "zod";

/**
 * A semantic (non-coordinate) description of an element, used for target
 * resolution fallback per docs/decisions/0001-element-targeting.md.
 * At least one field must be provided.
 */
export const SemanticTargetSchema = z
  .object({
    testId: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional()
  })
  .refine((target) => Object.values(target).some((value) => value !== undefined), {
    message: "target must specify at least one of testId, role, name, label, placeholder"
  });

export type SemanticTarget = z.infer<typeof SemanticTargetSchema>;

export const ActionTypeSchema = z.enum(["click", "fill", "navigate"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const BrowserActionSchema = z
  .object({
    snapshotId: z.string(),
    type: ActionTypeSchema,
    target: SemanticTargetSchema.optional(),
    value: z.string().optional(),
    url: z.string().optional(),
    timeoutMs: z.number().int().positive().max(60_000).default(5000)
  })
  .superRefine((action, ctx) => {
    if (action.type === "click" && !action.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "click requires a target"
      });
    }

    if (action.type === "fill") {
      if (!action.target) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: "fill requires a target"
        });
      }
      if (action.value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "fill requires a value"
        });
      }
    }

    if (action.type === "navigate" && action.url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "navigate requires a url"
      });
    }
  });

export type BrowserAction = z.infer<typeof BrowserActionSchema>;

/**
 * webcheck_act tool input. CURRENT_TASK.md's tool shape and the "Minimal
 * schemas" BrowserAction requirement both specify snapshotId, one at the
 * top level and one on the action itself. Both are kept and required to
 * match so the MCP tool's documented shape is honored while BrowserAction
 * remains self-describing when used outside the MCP boundary.
 */
export const ActInputSchema = z
  .object({
    sessionId: z.string(),
    snapshotId: z.string(),
    action: BrowserActionSchema
  })
  .refine((input) => input.snapshotId === input.action.snapshotId, {
    message: "top-level snapshotId must match action.snapshotId",
    path: ["action", "snapshotId"]
  });

export type ActInput = z.infer<typeof ActInputSchema>;
