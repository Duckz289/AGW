import { z } from "zod";

export const ObserveInputSchema = z.object({
  sessionId: z.string()
});

export type ObserveInput = z.infer<typeof ObserveInputSchema>;
