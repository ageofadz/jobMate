export function normalizeApplyUrl(href: string): string {
  let url: URL;

  try {
    url = new URL(href);
  } catch {
    return href;
  }

  const host = url.hostname.toLowerCase();

  if (host.endsWith("lever.co")) {
    const raw = url.pathname.replace(/\/+$/, "");
    const lower = raw.toLowerCase();

    if (lower.endsWith("/apply")) {
      return url.toString();
    }

    const segments = raw.split("/").filter(Boolean);

    if (segments.length >= 2) {
      url.pathname = `${raw}/apply`;
    }

    return url.toString();
  }

  if (host.includes("greenhouse.io")) {
    const pathSearchHash = `${url.pathname}${url.search}${url.hash}`.toLowerCase();

    if (pathSearchHash.includes("job")) {
      return url.toString();
    }

    const numericTail = url.pathname.match(/^\/([^/]+)\/(\d+)\/?$/);

    if (numericTail) {
      url.pathname = `/${numericTail[1]}/jobs/${numericTail[2]}`;
    }

    return url.toString();
  }

  return url.toString();
}
