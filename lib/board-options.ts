export type JobBoardOption = {
  id: string;
  label: string;
  domain: string;
};

export const JOB_BOARD_OPTIONS: JobBoardOption[] = [
  { id: "lever", label: "Lever.io", domain: "lever.co" },
  { id: "greenhouse", label: "Greenhouse", domain: "boards.greenhouse.io" },
  { id: "workatastartup", label: "Work at a Startup", domain: "workatastartup.com" },
  { id: "jobteaser", label: "JobTeaser", domain: "jobteaser.com" },
  { id: "smartrecruiters", label: "SmartRecruiters", domain: "smartrecruiters.com" },
  { id: "googlejobs", label: "Google Jobs", domain: "google.com" }
];

export const DEFAULT_BOARD_DOMAINS = JOB_BOARD_OPTIONS.map((o) => o.domain);

const DOMAIN_TO_OPTION_ID = new Map<string, string>();

for (const option of JOB_BOARD_OPTIONS) {
  DOMAIN_TO_OPTION_ID.set(option.domain, option.id);
}

DOMAIN_TO_OPTION_ID.set("jobs.lever.co", "lever");
DOMAIN_TO_OPTION_ID.set("greenhouse.io", "greenhouse");

export function boardOptionIdsFromDomains(domains: string[]): string[] {
  const ids = new Set<string>();

  for (const raw of domains) {
    const normalized = raw.trim().toLowerCase().replace(/^www\./, "");
    const id = DOMAIN_TO_OPTION_ID.get(normalized);

    if (id) {
      ids.add(id);
    }
  }

  return JOB_BOARD_OPTIONS.map((o) => o.id).filter((id) => ids.has(id));
}

export function boardDomainsFromOptionIds(ids: string[]): string[] {
  const set = new Set(ids);
  return JOB_BOARD_OPTIONS.filter((o) => set.has(o.id)).map((o) => o.domain);
}
