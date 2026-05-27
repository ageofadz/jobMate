function isWorkAtAStartupApplicantPortalPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  return /^\/application(\/|$)/.test(path) || /^\/applicants?(\/|$)/.test(path);
}

function isForbiddenNavigationUrl(url, baseUrl) {
  try {
    const resolved = new URL(url, baseUrl);
    const host = resolved.hostname.replace(/^www\./i, "").toLowerCase();
    const path = resolved.pathname.toLowerCase();
    if (host === "workatastartup.com") {
      if (isWorkAtAStartupApplicantPortalPath(path)) {
        return true;
      }
    }
    const knownProfilePaths =
      /\/profile|\/profiles|\/account|\/accounts|\/applicant|\/applicants|\/settings|\/users\/(?:me|edit)|\/me\b|\/dashboard|\/candidate|\/notifications|\/messages|\/inbox/i;
    if (knownProfilePaths.test(path)) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isAllowedNavigateUrl(url, baseUrl, pageHost, targetApplyUrl) {
  if (isForbiddenNavigationUrl(url, baseUrl)) {
    return false;
  }
  if (pageHost !== "workatastartup.com") {
    return true;
  }
  try {
    const resolved = new URL(url, baseUrl);
    const host = resolved.hostname.replace(/^www\./i, "").toLowerCase();
    const path = resolved.pathname.toLowerCase();
    if (host !== "workatastartup.com") {
      return true;
    }
    if (/\/jobs\/\d+/i.test(path)) {
      return true;
    }
    if (targetApplyUrl) {
      try {
        const targetNorm = new URL(targetApplyUrl, baseUrl).pathname.toLowerCase();
        if (path === targetNorm) {
          return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}
