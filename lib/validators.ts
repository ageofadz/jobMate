import { z } from "zod";

export const preferenceInputSchema = z.object({
  title: z.string().trim().min(2),
  locations: z.array(z.string().trim().min(2)).min(1),
  boardDomains: z.array(z.string().trim().min(3)).min(1),
  keywordSeed: z.array(z.string().trim().min(2)).default([]),
  searchAfterDays: z.number().int().min(1).max(365).default(14),
  contextBlock: z.string().trim().default(""),
  timezone: z.string().trim().min(3).default("America/Chicago"),
  scheduleHourLocal: z.number().int().min(0).max(23).default(9)
});

export type PreferenceInput = z.infer<typeof preferenceInputSchema>;
