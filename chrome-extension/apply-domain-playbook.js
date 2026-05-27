const PLAYBOOK_STORAGE_KEY = "jobmateApplyPlaybooks";

function normalizePlaybookPath(pathname) {
  return String(pathname || "")
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return "*";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "*";
      return seg;
    })
    .join("/");
}

function playbookHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function playbookStateKey(pageUrl, fieldCount) {
  try {
    const parsed = new URL(pageUrl);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    const path = normalizePlaybookPath(parsed.pathname);
    return `${host}|${path}|f${fieldCount}`;
  } catch {
    return `|f${fieldCount}`;
  }
}

function actionSignatureFromElement(element) {
  const tag = String(element.tag || "").toLowerCase();
  const text = String(element.text || "").replace(/\s+/g, " ").trim().slice(0, 120);
  let hrefPath = "";
  if (element.href) {
    try {
      hrefPath = normalizePlaybookPath(new URL(element.href, "https://example.com").pathname);
    } catch {}
  }
  return { tag, text, hrefPath };
}

function elementMatchesSignature(element, signature) {
  if (!signature) return false;
  const cand = actionSignatureFromElement(element);
  if (signature.tag && cand.tag !== signature.tag) return false;
  if (signature.text && cand.text.toLowerCase() !== signature.text.toLowerCase()) return false;
  if (signature.hrefPath && cand.hrefPath !== signature.hrefPath) return false;
  return Boolean(signature.text || signature.hrefPath);
}

function findElementBySignature(elements, signature) {
  for (const element of elements) {
    if (element.type !== "action") continue;
    if (elementMatchesSignature(element, signature)) return element;
  }
  return null;
}


async function loadPlaybooks() {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return {};
  const result = await new Promise((resolve) => {
    chrome.storage.local.get([PLAYBOOK_STORAGE_KEY], (stored) => {
      resolve(stored || {});
    });
  });
  return result[PLAYBOOK_STORAGE_KEY] || {};
}

async function savePlaybooks(playbooks) {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  await new Promise((resolve) => {
    chrome.storage.local.set({ [PLAYBOOK_STORAGE_KEY]: playbooks }, resolve);
  });
}

async function lookupPlaybookAction(pageUrl, fieldCount, elements, blockedIds) {
  const stateKey = playbookStateKey(pageUrl, fieldCount);
  const playbooks = await loadPlaybooks();
  const entry = playbooks[stateKey];
  if (!entry) return null;

  const blocked = blockedIds instanceof Set ? blockedIds : new Set(blockedIds || []);

  if (entry.tool === "click" || entry.tool === "submit") {
    const actions = (elements || []).filter((e) => e.type === "action" && !blocked.has(e.elementId));
    const matched = findElementBySignature(actions, entry.match);
    if (!matched) return null;
    return {
      tool: entry.tool,
      elementId: matched.elementId,
      url: null,
      reasoning: `Known path (${playbookHost(pageUrl)})`,
      fromPlaybook: true
    };
  }

  if (entry.tool === "navigate" && entry.url) {
    return {
      tool: "navigate",
      elementId: null,
      url: entry.url,
      reasoning: `Known path (${playbookHost(pageUrl)})`,
      fromPlaybook: true
    };
  }

  return null;
}

async function recordPlaybookStep(pageUrl, fieldCount, tool, element, navigateUrl) {
  const stateKey = playbookStateKey(pageUrl, fieldCount);
  const playbooks = await loadPlaybooks();
  const prev = playbooks[stateKey];
  playbooks[stateKey] = {
    tool,
    match: element ? actionSignatureFromElement(element) : null,
    url: navigateUrl || null,
    updatedAt: Date.now(),
    successCount: (prev?.successCount || 0) + 1
  };
  await savePlaybooks(playbooks);
}
