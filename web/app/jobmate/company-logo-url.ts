export function resolveCompanyLogoFetchUrl(stored: string | null | undefined): string | null {
  const trimmed = String(stored ?? "").trim();
  if (!trimmed) {
    return null;
  }

  let url = trimmed;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "next.jobteaser.com" || parsed.hostname.endsWith("jobteasercdn.com")) {
      const inner = parsed.searchParams.get("url");
      if (inner) {
        url = inner;
      }
    }
  } catch {
    return null;
  }

  if (url.startsWith("http://")) {
    url = `https://${url.slice(7)}`;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isAllowedCompanyLogoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
      return false;
    }
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function companyLogoProxyPath(stored: string | null | undefined): string | null {
  const fetchUrl = resolveCompanyLogoFetchUrl(stored);
  if (!fetchUrl || !isAllowedCompanyLogoUrl(fetchUrl)) {
    return null;
  }
  return `/api/job-logo?url=${encodeURIComponent(fetchUrl)}`;
}
