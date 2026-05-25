function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const applySessionByTabId = new Map();
const applyAutomationTabByPayload = new Map();

function getApplySession(tabId) {
  const entry = applySessionByTabId.get(tabId);
  if (!entry) return null;
  if (typeof entry === "string") return { payloadUrl: entry, openerTabId: null };
  return entry;
}

function setApplySession(tabId, payloadUrl, openerTabId) {
  applySessionByTabId.set(tabId, { payloadUrl, openerTabId: openerTabId ?? null });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  applySessionByTabId.delete(tabId);

  for (const [payloadUrl, automationTabId] of applyAutomationTabByPayload.entries()) {
    if (automationTabId === tabId) {
      applyAutomationTabByPayload.delete(payloadUrl);
    }
  }
});

function payloadForAutomationTab(tabId) {
  const session = getApplySession(tabId);

  if (session?.payloadUrl) {
    return { payloadUrl: session.payloadUrl, uiTabId: session.openerTabId ?? null };
  }

  for (const [payloadUrl, autoTabId] of applyAutomationTabByPayload.entries()) {
    if (autoTabId === tabId) {
      const autoSession = getApplySession(tabId);
      return { payloadUrl, uiTabId: autoSession?.openerTabId ?? null };
    }
  }

  return null;
}

async function registerApplyAutomationTab(tabId, payloadUrl, uiTabId) {
  applyAutomationTabByPayload.set(payloadUrl, tabId);
  setApplySession(tabId, payloadUrl, uiTabId);
  await chrome.tabs.update(tabId, { active: false }).catch(() => {});
}

async function openApplyAutomationTab(url, payloadUrl, uiTabId) {
  const existingId = applyAutomationTabByPayload.get(payloadUrl);

  if (existingId) {
    const existing = await chrome.tabs.get(existingId).catch(() => null);

    if (existing?.id) {
      applyAutomationTabByPayload.set(payloadUrl, existingId);
      setApplySession(existingId, payloadUrl, uiTabId);
      await chrome.tabs.update(existingId, { url, active: false }).catch(() => {});
      return existingId;
    }

    applyAutomationTabByPayload.delete(payloadUrl);
  }

  const created = await chrome.tabs.create({ url, active: false });
  const tabId = created.id;

  if (!tabId) {
    throw new Error("Failed to create apply automation tab.");
  }

  applyAutomationTabByPayload.set(payloadUrl, tabId);
  setApplySession(tabId, payloadUrl, uiTabId);
  await chrome.tabs.update(tabId, { active: false }).catch(() => {});
  return tabId;
}

function payloadUrlFromApplyTabUrl(url) {
  try {
    const hash = url.split("#")[1] || "";
    const value = new URLSearchParams(hash).get("jobmatePayload");
    return value ? decodeURIComponent(value) : "";
  } catch {
    return "";
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  const tabId = tab.id;
  const openerId = tab.openerTabId;

  if (!tabId || !openerId) {
    return;
  }

  const automation = payloadForAutomationTab(openerId);

  if (!automation) {
    return;
  }

  applyAutomationTabByPayload.set(automation.payloadUrl, tabId);
  setApplySession(tabId, automation.payloadUrl, automation.uiTabId);
  applySessionByTabId.delete(openerId);
  void chrome.tabs.remove(openerId);
  void chrome.tabs.update(tabId, { active: false });
});

async function createIsolatedCrawlerTab(initialUrl = "about:blank") {
  const createdWindow = await chrome.windows.create({
    url: initialUrl,
    focused: false,
    type: "popup",
    state: "minimized"
  });
  const tab = createdWindow.tabs?.[0];

  if (!tab?.id || !createdWindow.id) {
    if (createdWindow.id) {
      await chrome.windows.remove(createdWindow.id).catch(() => {});
    }

    throw new Error("Failed to create isolated crawler window.");
  }

  return {
    tabId: tab.id,
    windowId: createdWindow.id
  };
}

async function closeIsolatedCrawlerWindow(windowId) {
  await chrome.windows.remove(windowId).catch(() => {});
}

function waitTabComplete(tabId, ms = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab load timeout"));
    }, ms);

    function onUpdated(id, info) {
      if (id !== tabId || info.status !== "complete") {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (tab?.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

function extractPageHtmlInjected() {
  function isSecurityCheckText(text) {
    return /security checkup|Enable JavaScript and cookies to continue|challenge-platform|__CF\$cv/i.test(String(text || ""));
  }

  const html = document.documentElement?.outerHTML || "";
  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return {
    href: location.href,
    title: document.title || "",
    html,
    security: Boolean(bodyText) && (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText))
  };
}

async function readTabHtmlSnapshot(tabId) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageHtmlInjected
  });

  return injected[0]?.result || { href: "", title: "", html: "", security: false };
}

async function waitForTabHtml(tabId, timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const snap = await readTabHtmlSnapshot(tabId);

    if (snap.html && !snap.security) {
      return snap;
    }

    await sleep(900);
  }

  throw new Error("Timed out waiting for page HTML.");
}

function scrapeGoogleOrganicInjected() {
  const out = [];
  const seen = new Set();

  function unwrapGoogleRedirect(href) {
    let h = href;

    if (/google\.[^/]+\/url\?/i.test(h) || /^\/url\?/i.test(h) || /\/url\?/i.test(h)) {
      try {
        const u = new URL(h, "https://www.google.com");
        const q = u.searchParams.get("q") || u.searchParams.get("url");

        if (q) {
          h = q;
        }
      } catch (_) {}
    }

    return h;
  }

  function normalizeAnchorHref(a) {
    let href = a.getAttribute("href") || "";

    if (href.startsWith("/")) {
      try {
        href = new URL(href, "https://www.google.com").href;
      } catch (_) {
        return "";
      }
    }

    href = unwrapGoogleRedirect(href);

    if (!/^https?:\/\//i.test(href)) {
      return "";
    }

    try {
      const hostname = new URL(href).hostname;

      if (/^google\./i.test(hostname) || /googleusercontent\.com$/i.test(hostname)) {
        return "";
      }

      return href;
    } catch (_) {
      return "";
    }
  }

  function titleFromAnchor(a, h3) {
    if (h3) {
      const t = String(h3.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (t.length >= 2) {
        return t;
      }
    }

    const heading = a.querySelector('[role="heading"]');

    if (heading) {
      const t = String(heading.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (t.length >= 2) {
        return t;
      }
    }

    return "";
  }

  function snippetForAnchor(a, title) {
    let snippet = "";
    const block = a.closest("div[data-hveid], div.g, div[jscontroller], div[data-snf], div.MjjYud");

    if (block) {
      const spans = block.querySelectorAll("span");

      for (const sp of spans) {
        const t = String(sp.textContent || "")
          .replace(/\s+/g, " ")
          .trim();

        if (t.length > 40 && t !== title && !/^https?:\/\//i.test(t)) {
          snippet = t.slice(0, 240);
          break;
        }
      }
    }

    return snippet;
  }

  function pushResult(href, title, a) {
    if (!href || !title || seen.has(href)) {
      return;
    }

    seen.add(href);

    let hostname = "";

    try {
      hostname = new URL(href).hostname;
    } catch (_) {
      return;
    }

    out.push({
      title,
      link: href,
      displayedLink: hostname.replace(/^www\./i, ""),
      snippet: snippetForAnchor(a, title)
    });
  }

  const rso = document.querySelector("#rso");
  const roots = [];

  if (rso) {
    roots.push(rso);
  }

  roots.push(document.body);

  for (const root of roots) {
    const headers = root.querySelectorAll("a h3");

    for (const h3 of headers) {
      const a = h3.closest("a");

      if (!a) {
        continue;
      }

      const href = normalizeAnchorHref(a);
      const title = titleFromAnchor(a, h3);

      if (!href || !title) {
        continue;
      }

      pushResult(href, title, a);

      if (out.length >= 50) {
        return out;
      }
    }
  }

  if (out.length < 8 && rso) {
    const anchors = rso.querySelectorAll('a[href^="http"], a[href^="/url"]');

    for (const a of anchors) {
      const href = normalizeAnchorHref(a);

      if (!href) {
        continue;
      }

      const title = titleFromAnchor(a, a.querySelector("h3"));

      if (!title) {
        continue;
      }

      pushResult(href, title, a);

      if (out.length >= 50) {
        break;
      }
    }
  }

  return out;
}

function scrapeJobTeaserSearchInjected() {
  function isSecurityCheckText(text) {
    return /security checkup|Enable JavaScript and cookies to continue|challenge-platform|__CF\$cv/i.test(String(text || ""));
  }

  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a.JobAdCard-module__gW-NAa__link[href*="/job-offers/"]');

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    let absoluteHref = "";

    try {
      absoluteHref = new URL(href, location.href).toString();
    } catch (_) {
      continue;
    }

    if (!absoluteHref || seen.has(absoluteHref)) {
      continue;
    }

    const title = String(anchor.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title) {
      continue;
    }

    seen.add(absoluteHref);

    const card = anchor.closest('[data-testid="jobad-card"]') || anchor.closest("li") || anchor.parentElement;
    const company = String(card?.querySelector('[data-testid="jobad-card-company-name"]')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const contract = String(card?.querySelector('[data-testid="jobad-card-contract"] span:last-of-type')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const locationText = String(card?.querySelector('[data-testid="jobad-card-location"] span:last-of-type')?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();

    let sourceHost = "";

    try {
      sourceHost = new URL(absoluteHref).hostname.replace(/^www\./i, "");
    } catch (_) {
      sourceHost = "jobteaser.com";
    }

    out.push({
      sourceUrl: absoluteHref,
      sourceTitle: title,
      sourceHost,
      company: company || "Company",
      location: locationText || "Unknown",
      snippet: [company, contract, locationText].filter(Boolean).join(" · ")
    });
  }

  const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  const security =
    out.length === 0 &&
    Boolean(bodyText) &&
    (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText));

  return { security, results: out };
}

function scrapeWorkAtAStartupSearchInjected() {
  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isSecurityCheckText(text) {
    return /security check|verify you are human|enable javascript and cookies|cf[- ]challenge|checking your browser/i.test(
      String(text || "")
    );
  }

  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href*="/jobs/"]');

  for (const anchor of anchors) {
    let absoluteHref = "";
    let parsedHref = null;

    try {
      absoluteHref = new URL(anchor.getAttribute("href") || "", location.href).toString();
      parsedHref = new URL(absoluteHref);
    } catch (_) {
      continue;
    }

    if (
      !parsedHref ||
      parsedHref.hostname.replace(/^www\./i, "").toLowerCase() !== "workatastartup.com" ||
      !/^\/jobs\/\d+\/?$/i.test(parsedHref.pathname) ||
      seen.has(absoluteHref)
    ) {
      continue;
    }

    const title = cleanText(anchor.textContent);

    if (!title || /^view job$/i.test(title)) {
      continue;
    }

    seen.add(absoluteHref);

    const card =
      anchor.closest("div.mb-2") ||
      anchor.closest("article") ||
      anchor.closest("li") ||
      anchor.parentElement;
    const metaParts = Array.from(card?.querySelectorAll("span") || [])
      .map((node) => cleanText(node.textContent))
      .filter((part) => part && !/^job match$/i.test(part) && !/^view job$/i.test(part));
    const locationText =
      metaParts.find((part) => /(remote|hybrid|on[- ]site|[A-Za-z .'-]+,\s*[A-Z]{2},\s*[A-Z]{2})/i.test(part)) || "Unknown";

    out.push({
      sourceUrl: absoluteHref,
      sourceTitle: title,
      sourceHost: "workatastartup.com",
      company: "Company",
      location: locationText,
      snippet: metaParts.join(" · ")
    });
  }

  const bodyText = cleanText(document.body?.innerText || "").slice(0, 4000);
  const security =
    out.length === 0 &&
    Boolean(bodyText) &&
    (isSecurityCheckText(document.title || "") || isSecurityCheckText(bodyText));

  return { security, results: out };
}

async function scrapeQueryAllPages(tabId, query, limit) {
  const collected = [];
  const seenLinks = new Set();
  let start = 0;
  const maxPages = 15;

  for (let page = 0; page < maxPages && collected.length < limit; page++) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&nfpr=1&filter=0&start=${start}`;
    await chrome.tabs.update(tabId, { url });
    await waitTabComplete(tabId);
    await sleep(550);

    let results = [];

    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeGoogleOrganicInjected
        });
        results = injected[0]?.result || [];
      } catch (_) {
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      await sleep(380 + attempt * 140);
    }

    if (!results.length) {
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.link || seenLinks.has(row.link)) {
        continue;
      }

      seenLinks.add(row.link);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }

    start += 10;
  }

  return collected.slice(0, limit);
}

async function scrapeJobTeaserSpec(tabId, spec, limit) {
  const collected = [];
  const seenLinks = new Set();
  const maxPages = Math.max(1, Math.min(10, Math.ceil(limit / 20) + 1));

  for (let page = 1; page <= maxPages && collected.length < limit; page++) {
    const url = new URL(spec.url);

    if (page > 1) {
      url.searchParams.set("page", String(page));
    } else {
      url.searchParams.delete("page");
    }

    await chrome.tabs.update(tabId, { url: url.toString() });
    await waitTabComplete(tabId);

    let results = [];
    let security = false;

    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeJobTeaserSearchInjected
        });
        const payload = injected[0]?.result || { security: false, results: [] };
        security = Boolean(payload.security);
        results = Array.isArray(payload.results) ? payload.results : [];
      } catch (_) {
        security = false;
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      if (!security && attempt >= 4) {
        break;
      }

      await sleep(900);
    }

    if (!results.length) {
      if (security) {
        throw new Error(`JobTeaser page stayed behind a security check for ${spec.label}.`);
      }
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.sourceUrl || seenLinks.has(row.sourceUrl)) {
        continue;
      }

      seenLinks.add(row.sourceUrl);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }
  }

  return collected.slice(0, limit);
}

async function scrapeWorkAtAStartupSpec(tabId, spec, limit) {
  const collected = [];
  const seenLinks = new Set();
  const maxPages = Math.max(1, Math.min(10, Math.ceil(limit / 20) + 1));

  for (let page = 1; page <= maxPages && collected.length < limit; page++) {
    const url = new URL(spec.url);

    if (page > 1) {
      url.searchParams.set("page", String(page));
    } else {
      url.searchParams.delete("page");
    }

    await chrome.tabs.update(tabId, { url: url.toString() });
    await waitTabComplete(tabId);

    let results = [];
    let security = false;

    for (let attempt = 0; attempt < 24; attempt++) {
      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeWorkAtAStartupSearchInjected
        });
        const payload = injected[0]?.result || { security: false, results: [] };
        security = Boolean(payload.security);
        results = Array.isArray(payload.results) ? payload.results : [];
      } catch (_) {
        security = false;
        results = [];
      }

      if (results.length > 0) {
        break;
      }

      if (!security && attempt >= 6) {
        break;
      }

      await sleep(900);
    }

    if (!results.length) {
      if (security) {
        throw new Error(`Work at a Startup page stayed behind a security check for ${spec.label}.`);
      }
      break;
    }

    let newCount = 0;

    for (const row of results) {
      if (!row.sourceUrl || seenLinks.has(row.sourceUrl)) {
        continue;
      }

      seenLinks.add(row.sourceUrl);
      collected.push(row);
      newCount += 1;

      if (collected.length >= limit) {
        break;
      }
    }

    if (newCount === 0) {
      break;
    }
  }

  return collected.slice(0, limit);
}

async function runGoogleBatch(queryList, limitPerQuery) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const byQuery = {};

  try {
    for (const query of queryList) {
      byQuery[query] = await scrapeQueryAllPages(crawler.tabId, query, limitPerQuery);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId);
  }

  return byQuery;
}

async function runJobTeaserBatch(specs, limitPerSpec) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const bySpecId = {};

  try {
    for (const spec of specs) {
      bySpecId[spec.id] = await scrapeJobTeaserSpec(crawler.tabId, spec, limitPerSpec);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId);
  }

  return bySpecId;
}

async function runWorkAtAStartupBatch(specs, limitPerSpec) {
  const crawler = await createIsolatedCrawlerTab("about:blank");
  const bySpecId = {};

  try {
    for (const spec of specs) {
      bySpecId[spec.id] = await scrapeWorkAtAStartupSpec(crawler.tabId, spec, limitPerSpec);
    }
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId);
  }

  return bySpecId;
}

async function fetchPageHtmlInHiddenTab(url) {
  const crawler = await createIsolatedCrawlerTab(url);

  try {
    await waitTabComplete(crawler.tabId);
    const snap = await waitForTabHtml(crawler.tabId);
    return {
      ok: true,
      finalUrl: snap.href || url,
      html: snap.html || ""
    };
  } finally {
    await closeIsolatedCrawlerWindow(crawler.windowId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "JOBMATE_APPLY_SESSION_SET") {
    (async () => {
      if (sender.tab?.id && typeof msg.payloadUrl === "string" && msg.payloadUrl.trim()) {
        const payloadUrl = msg.payloadUrl.trim();
        const existing = getApplySession(sender.tab.id);
        const uiTabId = existing?.openerTabId ?? sender.tab.openerTabId ?? null;
        await registerApplyAutomationTab(sender.tab.id, payloadUrl, uiTabId);
      }

      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_OPEN_BACKGROUND_TAB") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      try {
        const tab = await chrome.tabs.create({ url, active: false });
        sendResponse({ ok: true, tabId: tab.id ?? null });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_OPEN_APPLY_TAB") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";
      const payloadUrl = typeof msg.payloadUrl === "string" ? msg.payloadUrl.trim() : "";
      const senderTabId = sender.tab?.id ?? null;

      if (!url || !payloadUrl) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      try {
        const tabId = await openApplyAutomationTab(url, payloadUrl, senderTabId);

        if (senderTabId) {
          await chrome.tabs
            .sendMessage(senderTabId, {
              type: "JOBMATE_APPLY_STARTED",
              tabId,
              applyUrl: url
            })
            .catch(() => {});
        }

        sendResponse({ ok: true, tabId });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_IS_RUNNER") {
    const tabId = sender.tab?.id;
    const payloadUrl = typeof msg.payloadUrl === "string" ? msg.payloadUrl.trim() : "";
    const automationTabId = payloadUrl ? applyAutomationTabByPayload.get(payloadUrl) : null;

    sendResponse({ ok: Boolean(tabId && automationTabId === tabId) });
    return false;
  }

  if (msg?.type === "JOBMATE_EMAIL_SYNC") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL", text: "" });
        return;
      }

      let tabId = null;

      try {
        const tab = await chrome.tabs.create({ url, active: false });
        tabId = tab.id;
        await waitTabComplete(tabId);
        await sleep(3000);
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40000)
        });
        const text = injected[0]?.result || "";
        await chrome.tabs.remove(tabId).catch(() => {});
        tabId = null;
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err), text: "" });
      }
    })();
    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_NEEDS_ATTENTION") {
    (async () => {
      const applyTabId = sender.tab?.id;
      const session = applyTabId ? getApplySession(applyTabId) : null;
      const applyTab = applyTabId ? await chrome.tabs.get(applyTabId).catch(() => null) : null;
      const notifyTabId = session?.openerTabId ?? applyTab?.openerTabId ?? null;
      const payload = {
        type: "JOBMATE_APPLY_ATTENTION",
        message: typeof msg.message === "string" ? msg.message : "",
        instruction: typeof msg.instruction === "string" ? msg.instruction : "",
        applyUrl: typeof msg.applyUrl === "string" ? msg.applyUrl : applyTab?.url || ""
      };

      if (notifyTabId) {
        await chrome.tabs.sendMessage(notifyTabId, payload).catch(() => {});
      }

      if (applyTabId && applyTab?.windowId) {
        await chrome.windows.update(applyTab.windowId, { focused: true }).catch(() => {});
        await chrome.tabs.update(applyTabId, { active: true }).catch(() => {});
      } else if (!notifyTabId) {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          const url = tab.url || "";
          if (!tab.id || tab.id === applyTabId) continue;
          if (!/localhost|127\.0\.0\.1/.test(url)) continue;
          await chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
        }
      }

      sendResponse({ ok: true });
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_SESSION_LOOKUP") {
    (async () => {
      const tabId = sender.tab?.id;

      if (!tabId) {
        sendResponse({ ok: true, payloadUrl: null });
        return;
      }

      const session = getApplySession(tabId);
      const payloadUrl = session?.payloadUrl ?? "";
      const automationTabId = payloadUrl ? applyAutomationTabByPayload.get(payloadUrl) : null;

      if (!payloadUrl || automationTabId !== tabId) {
        sendResponse({ ok: true, payloadUrl: null });
        return;
      }

      sendResponse({ ok: true, payloadUrl });
    })();

    return true;
  }

  if (msg?.type === "JOBMATE_APPLY_SESSION_CLEAR") {
    const tabId = sender.tab?.id;
    const session = tabId ? getApplySession(tabId) : null;
    const payloadUrl = session?.payloadUrl ?? "";

    if (tabId) {
      applySessionByTabId.delete(tabId);
    }

    if (payloadUrl) {
      applyAutomationTabByPayload.delete(payloadUrl);
    }

    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === "jobmate_fetch") {
    (async () => {
      let replied = false;

      function reply(payload) {
        if (!replied) {
          replied = true;
          sendResponse(payload);
        }
      }

      try {
        const method = typeof msg.method === "string" ? msg.method.toUpperCase() : "GET";
        const headers = msg.headers && typeof msg.headers === "object" ? msg.headers : {};
        const init = {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : msg.body
        };

        let res = await fetch(msg.url, init).catch(() => null);

        if (!res) {
          await sleep(200);
          res = await fetch(msg.url, init);
        }

        const text = await res.text();
        reply({ ok: res.ok, status: res.status, text });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true;
  }

  if (msg?.type === "GOOGLE_SEARCH_BATCH") {
    (async () => {
      const queryList = Array.isArray(msg.queries) ? msg.queries.map(String) : [];
      const limitPerQuery = Math.max(1, Math.min(100, Number(msg.limitPerQuery) || 100));

      if (!queryList.length) {
        sendResponse({ ok: false, error: "No queries", byQuery: {} });
        return;
      }

      try {
        const byQuery = await runGoogleBatch(queryList, limitPerQuery);
        sendResponse({ ok: true, byQuery });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          byQuery: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "JOBTEASER_SEARCH_BATCH") {
    (async () => {
      const specs = Array.isArray(msg.specs)
        ? msg.specs
            .filter((spec) => spec && typeof spec.id === "string" && typeof spec.url === "string")
            .map((spec) => ({
              id: String(spec.id),
              label: String(spec.label || spec.id),
              url: String(spec.url)
            }))
        : [];
      const limitPerSpec = Math.max(1, Math.min(100, Number(msg.limitPerSpec) || 100));

      if (!specs.length) {
        sendResponse({ ok: false, error: "No JobTeaser specs", bySpecId: {} });
        return;
      }

      try {
        const bySpecId = await runJobTeaserBatch(specs, limitPerSpec);
        sendResponse({ ok: true, bySpecId });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          bySpecId: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "WORKATASTARTUP_SEARCH_BATCH") {
    (async () => {
      const specs = Array.isArray(msg.specs)
        ? msg.specs
            .filter((spec) => spec && typeof spec.id === "string" && typeof spec.url === "string")
            .map((spec) => ({
              id: String(spec.id),
              label: String(spec.label || spec.id),
              url: String(spec.url)
            }))
        : [];
      const limitPerSpec = Math.max(1, Math.min(100, Number(msg.limitPerSpec) || 100));

      if (!specs.length) {
        sendResponse({ ok: false, error: "No Work at a Startup specs", bySpecId: {} });
        return;
      }

      try {
        const bySpecId = await runWorkAtAStartupBatch(specs, limitPerSpec);
        sendResponse({ ok: true, bySpecId });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          bySpecId: {}
        });
      }
    })();

    return true;
  }

  if (msg?.type === "FETCH_PAGE_HTML") {
    (async () => {
      const url = typeof msg.url === "string" ? msg.url.trim() : "";

      if (!url) {
        sendResponse({ ok: false, error: "No URL" });
        return;
      }

      try {
        const payload = await fetchPageHtmlInHiddenTab(url);
        sendResponse(payload);
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();

    return true;
  }

  return false;
});
