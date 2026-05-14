export function formatProfileBlock(row: Record<string, unknown>): string {
  const lines: string[] = [];

  const fn = String(row.full_name ?? "").trim();
  const em = String(row.email ?? "").trim();
  const loc = String(row.location ?? "").trim();
  const cloc = String(row.current_location ?? "").trim();
  const phone = String(row.phone ?? "").trim();
  const li = String(row.linkedin_url ?? "").trim();
  const comp = String(row.preferred_comp_range ?? "").trim();
  const web = String(row.website ?? "").trim();
  const wh = String(row.work_history ?? "").trim();
  const skills = String(row.skills ?? "").trim();
  const essay = String(row.essay ?? "").trim();

  if (fn) {
    lines.push(`Name: ${fn}`);
  }

  if (em) {
    lines.push(`Email: ${em}`);
  }

  if (loc) {
    lines.push(`Location: ${loc}`);
  }

  if (cloc) {
    lines.push(`Current location: ${cloc}`);
  }

  if (phone) {
    lines.push(`Phone: ${phone}`);
  }

  if (li) {
    lines.push(`LinkedIn: ${li}`);
  }

  if (comp) {
    lines.push(`Preferred compensation range: ${comp}`);
  }

  if (web) {
    lines.push(`Website: ${web}`);
  }

  if (wh) {
    lines.push(`Work history:\n${wh}`);
  }

  if (skills) {
    lines.push(`Skills:\n${skills}`);
  }

  if (essay) {
    lines.push(`Writing sample:\n${essay}`);
  }

  return lines.join("\n\n");
}
