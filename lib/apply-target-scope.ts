function trimTrailingSlashes(path: string): string {
  let p = String(path || "");
  while (p.length > 1 && p.charAt(p.length - 1) === "/") {
    p = p.slice(0, -1);
  }
  return p || "/";
}

function isDigitChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHexChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

function isDigitRun(value: string, minLen: number): boolean {
  const s = String(value || "");
  if (s.length < minLen) return false;
  for (let i = 0; i < s.length; i++) {
    if (!isDigitChar(s.charAt(i))) return false;
  }
  return true;
}

function extractLongestDigitRun(value: string, minLen: number): string {
  const s = String(value || "");
  let best = "";
  let run = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (isDigitChar(ch)) {
      run += ch;
    } else if (run.length >= minLen && run.length > best.length) {
      best = run;
      run = "";
    } else {
      run = "";
    }
  }
  if (run.length >= minLen && run.length > best.length) best = run;
  return best;
}

function isUuidToken(token: string): boolean {
  const parts = String(token || "").split("-");
  if (parts.length !== 5) return false;
  const lens = [8, 4, 4, 4, 12];
  for (let i = 0; i < 5; i++) {
    if (parts[i].length !== lens[i]) return false;
    for (let j = 0; j < parts[i].length; j++) {
      if (!isHexChar(parts[i].charAt(j))) return false;
    }
  }
  return true;
}

export function normalizeApplyScopeUrl(url: string, baseUrl?: string): string {
  try {
    const parsed = new URL(url, baseUrl || undefined);
    parsed.hash = "";
    const path = trimTrailingSlashes(parsed.pathname);
    return `${parsed.origin}${path}${parsed.search}`;
  } catch {
    return url.trim();
  }
}

export function extractJobUrlIdentifiers(url: string, baseUrl?: string): Set<string> {
  const ids = new Set<string>();
  try {
    const parsed = new URL(url, baseUrl || undefined);
    const segments = parsed.pathname.split("/");
    for (const seg of segments) {
      if (!seg) continue;
      const dot = seg.lastIndexOf(".");
      const base = dot > 0 ? seg.slice(0, dot) : seg;
      if (isDigitRun(base, 5)) ids.add(base);
      const run = extractLongestDigitRun(base, 5);
      if (run) ids.add(run);
      if (isUuidToken(base)) ids.add(base.toLowerCase());
      if (isUuidToken(seg)) ids.add(seg.toLowerCase());
    }
    for (const value of parsed.searchParams.values()) {
      if (isDigitRun(value, 5)) ids.add(value);
      const run = extractLongestDigitRun(value, 5);
      if (run) ids.add(run);
      if (isUuidToken(value)) ids.add(value.toLowerCase());
    }
  } catch {
  }
  return ids;
}

function htmlStemParentPrefix(path: string): string | null {
  const trimmed = trimTrailingSlashes(path);
  const slash = trimmed.lastIndexOf("/");
  const leaf = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  if (leaf.slice(dot + 1).toLowerCase() !== "html") return null;
  return trimmed.slice(0, trimmed.length - (leaf.length - dot)) + "/";
}

function pathPrefixRelationship(pathA: string, pathB: string): boolean {
  const a = trimTrailingSlashes(pathA);
  const b = trimTrailingSlashes(pathB);
  if (a === b) return true;
  const bPrefix = b + "/";
  const aPrefix = a + "/";
  if (a.length > b.length && a.slice(0, bPrefix.length) === bPrefix) return true;
  if (b.length > a.length && b.slice(0, aPrefix.length) === aPrefix) return true;
  const aStemPrefix = htmlStemParentPrefix(a);
  if (aStemPrefix && b.startsWith(aStemPrefix) && b !== a) return true;
  const bStemPrefix = htmlStemParentPrefix(b);
  if (bStemPrefix && a.startsWith(bStemPrefix) && a !== b) return true;
  return false;
}

function resolveActionUrl(href: string, pageUrl: string): string {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return "";
  }
}

function listingStemPrefixes(applyAnchorUrls: string[], pageUrl: string): Set<string> {
  const stems = new Set<string>();
  for (const raw of applyAnchorUrls) {
    if (!raw) continue;
    try {
      const path = trimTrailingSlashes(new URL(raw, pageUrl).pathname);
      const stem = htmlStemParentPrefix(path);
      if (stem) stems.add(stem);
    } catch {
    }
  }
  return stems;
}

export function isStemChildApplyPath(resolvedUrl: string, applyAnchorUrls: string[], pageUrl: string): boolean {
  if (!resolvedUrl) return false;
  try {
    const path = trimTrailingSlashes(new URL(resolvedUrl, pageUrl).pathname);
    for (const stem of listingStemPrefixes(applyAnchorUrls, pageUrl)) {
      if (path.startsWith(stem) && path.length > stem.length) return true;
    }
  } catch {
  }
  return false;
}

function actionScopeTier(
  action: { href?: string | null; url?: string | null },
  applyAnchorUrls: string[],
  pageUrl: string
): number {
  const href = action.href || action.url || "";
  if (!href) return 3;
  const resolved = resolveActionUrl(href, pageUrl);
  if (!resolved) return 4;
  const pageNorm = normalizeApplyScopeUrl(pageUrl, pageUrl);
  const resolvedNorm = normalizeApplyScopeUrl(resolved, pageUrl);
  if (!isSameJobApplyScope(resolved, applyAnchorUrls, pageUrl)) return 4;
  if (resolvedNorm !== pageNorm) return 1;
  return 2;
}

export function prioritizeA11yActions<T extends { href?: string | null; url?: string | null }>(
  actions: T[],
  applyAnchorUrls: string[],
  pageUrl: string
): T[] {
  return [...actions].sort(
    (a, b) => actionScopeTier(a, applyAnchorUrls, pageUrl) - actionScopeTier(b, applyAnchorUrls, pageUrl)
  );
}

export function prioritizeActionsForClassifier<T extends { href?: string | null; url?: string | null }>(
  actions: T[],
  applyAnchorUrls: string[],
  pageUrl: string,
  maxCount: number
): T[] {
  const tiers: T[][] = [[], [], [], []];
  for (const action of actions) {
    const tierIndex = actionScopeTier(action, applyAnchorUrls, pageUrl) - 1;
    if (tierIndex >= 0 && tierIndex < 4) tiers[tierIndex].push(action);
    else tiers[3].push(action);
  }
  const out: T[] = [];
  for (const tier of tiers) {
    for (const action of tier) {
      if (out.length >= maxCount) return out;
      out.push(action);
    }
  }
  return out;
}

export function rankScopedApplyAdvancingActions(
  actions: Array<{ elementId: string; href?: string | null; url?: string | null }>,
  applyAnchorUrls: string[],
  pageUrl: string,
  guardFail: (action: { elementId: string; href?: string | null; url?: string | null }) => boolean
): string[] {
  const pageNorm = normalizeApplyScopeUrl(pageUrl, pageUrl);
  const candidates: Array<{ elementId: string; pathLen: number }> = [];
  for (const action of actions) {
    if (guardFail(action)) continue;
    const href = action.href || action.url || "";
    if (!href) continue;
    const resolved = resolveActionUrl(href, pageUrl);
    if (!resolved) continue;
    if (normalizeApplyScopeUrl(resolved, pageUrl) === pageNorm) continue;
    if (!isSameJobApplyScope(resolved, applyAnchorUrls, pageUrl)) continue;
    if (!isStemChildApplyPath(resolved, applyAnchorUrls, pageUrl)) continue;
    let pathLen = 0;
    try {
      pathLen = trimTrailingSlashes(new URL(resolved, pageUrl).pathname).length;
    } catch {
    }
    candidates.push({ elementId: action.elementId, pathLen });
  }
  candidates.sort((a, b) => b.pathLen - a.pathLen);
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!out.includes(candidate.elementId)) out.push(candidate.elementId);
  }
  return out;
}

function resolveApplyAnchorUrls(anchorUrls: string[], baseUrl: string): URL[] {
  const anchors: URL[] = [];
  for (const raw of anchorUrls) {
    if (!raw) continue;
    try {
      anchors.push(new URL(raw, baseUrl));
    } catch {
    }
  }
  return anchors;
}

function identifierOverlap(candidateIds: Set<string>, anchorIdsList: Set<string>[]): boolean {
  for (const anchorIds of anchorIdsList) {
    for (const id of candidateIds) {
      if (anchorIds.has(id)) return true;
    }
  }
  return false;
}

export function isSameJobApplyScope(candidateUrl: string, anchorUrls: string[], baseUrl: string): boolean {
  if (!candidateUrl) return false;
  const anchors = resolveApplyAnchorUrls(anchorUrls, baseUrl);
  if (!anchors.length) return true;

  const candidateNorm = normalizeApplyScopeUrl(candidateUrl, baseUrl);
  try {
    const candidate = new URL(candidateUrl, baseUrl);
    const candidateIds = extractJobUrlIdentifiers(candidateUrl, baseUrl);

    for (const anchor of anchors) {
      const anchorNorm = normalizeApplyScopeUrl(anchor.toString(), baseUrl);
      if (candidateNorm === anchorNorm) return true;

      if (candidate.origin === anchor.origin) {
        const cPath = trimTrailingSlashes(candidate.pathname);
        const aPath = trimTrailingSlashes(anchor.pathname);
        if (pathPrefixRelationship(cPath, aPath)) return true;
      }

      const anchorIds = extractJobUrlIdentifiers(anchor.toString(), baseUrl);
      if (candidateIds.size && anchorIds.size) {
        for (const id of candidateIds) {
          if (anchorIds.has(id)) return true;
        }
      }
    }
  } catch {
  }
  return false;
}

export function isOffTargetJobUrl(candidateUrl: string, anchorUrls: string[], baseUrl: string): boolean {
  if (!candidateUrl) return false;
  if (isSameJobApplyScope(candidateUrl, anchorUrls, baseUrl)) return false;

  try {
    const anchors = resolveApplyAnchorUrls(anchorUrls, baseUrl);
    const candidateIds = extractJobUrlIdentifiers(candidateUrl, baseUrl);
    if (candidateIds.size > 0) {
      const anchorIdsList = anchors.map((anchor) => extractJobUrlIdentifiers(anchor.toString(), baseUrl));
      if (!identifierOverlap(candidateIds, anchorIdsList)) return true;
    }
  } catch {
  }
  return false;
}

export function isReturnToListingUrl(candidateUrl: string, listingUrl: string, baseUrl: string): boolean {
  if (!candidateUrl || !listingUrl) return false;
  return normalizeApplyScopeUrl(candidateUrl, baseUrl) === normalizeApplyScopeUrl(listingUrl, baseUrl);
}

export function buildApplyAnchorUrls(targetApplyUrl: string, hiddenApplyUrl?: string | null): string[] {
  return [targetApplyUrl, hiddenApplyUrl ?? ""].filter(Boolean);
}

export function isAllowedNavigateUrl(
  url: string,
  baseUrl: string,
  _pageHost: string,
  targetApplyUrl: string,
  hiddenApplyUrl: string | null | undefined,
  hasLeftTargetListing: boolean
): boolean {
  if (hasLeftTargetListing && targetApplyUrl && isReturnToListingUrl(url, targetApplyUrl, baseUrl)) {
    return false;
  }
  const anchors = [targetApplyUrl, hiddenApplyUrl ?? ""].filter(Boolean);
  if (!anchors.length) {
    return true;
  }
  return isSameJobApplyScope(url, anchors, baseUrl);
}

export function resolveStemChildActionUrl(
  action: { href?: string } | undefined,
  applyAnchorUrls: string[],
  pageUrl: string
): string | null {
  const href = action?.href ?? "";
  if (!href) return null;
  try {
    const resolved = new URL(href, pageUrl).toString();
    if (!isStemChildApplyPath(resolved, applyAnchorUrls, pageUrl)) return null;
    return resolved;
  } catch {
    return null;
  }
}
