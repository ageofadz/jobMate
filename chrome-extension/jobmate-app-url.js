var JOBMATE_APP_HOSTS = {
  localhost: true,
  "127.0.0.1": true,
  "job-mate-theta.vercel.app": true
};

function isJobMateAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (!JOBMATE_APP_HOSTS[parsed.hostname.toLowerCase()]) {
      return false;
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return path === "/";
  } catch {
    return false;
  }
}
