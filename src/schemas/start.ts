import { z } from "zod";

export const StartInputSchema = z.object({
  url: z.string(),
  headless: z.boolean().optional()
});

export type StartInput = z.infer<typeof StartInputSchema>;
