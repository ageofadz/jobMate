import { z } from "zod";

export function coalesceLocationFragments(locations: string[]): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < locations.length) {
    const city = locations[index]?.trim() ?? "";

    if (
      index + 2 < locations.length &&
      city &&
      /^[A-Za-z .'-]+$/.test(city) &&
      /^[A-Z]{2}$/i.test(locations[index + 1]?.trim() ?? "") &&
      /^US$/i.test(locations[index + 2]?.trim() ?? "")
    ) {
      out.push(`${city}, ${locations[index + 1].trim()}, ${locations[index + 2].trim()}`);
      index += 3;
      continue;
    }

    if (city) {
      out.push(city);
    }

    index += 1;
  }

  return out;
}

export function splitLocations(raw: string): string[] {
  return raw
    .split(/\r?\n|;/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function formatLocationsForInput(locations: string[]): string {
  return coalesceLocationFragments(locations).join("\n");
}

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
