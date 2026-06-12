(function () {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function extensionMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const last = chrome.runtime.lastError;
        if (last) {
          reject(new Error(last.message));
          return;
        }
        if (!response) {
          reject(new Error(`Background returned no response for ${message?.type} — background script may not have a handler for this message type.`));
          return;
        }
        resolve(response);
      });
    });
  }

  let applySessionTargetUrl = "";
  let hasLeftTargetListing = false;

  function getApplyAnchors(hiddenApplyUrl) {
    return [applySessionTargetUrl, hiddenApplyUrl].filter(Boolean);
  }

  async function resolvePayloadUrl() {
    const sessionId = hash.get("jobmateSession");
    if (sessionId) {
      history.replaceState(null, document.title, location.pathname + location.search);
      const payloadUrl = `ext://session/${sessionId}`;
      await extensionMessage({ type: "JOBMATE_APPLY_SESSION_SET", payloadUrl }).catch(() => { });
      return payloadUrl;
    }
    const fromHash = hash.get("jobmatePayload");
    if (fromHash) {
      history.replaceState(null, document.title, location.pathname + location.search);
      await extensionMessage({ type: "JOBMATE_APPLY_SESSION_SET", payloadUrl: fromHash }).catch(() => { });
      return fromHash;
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const lookup = await extensionMessage({ type: "JOBMATE_APPLY_SESSION_LOOKUP" }).catch(() => null);
      const payloadUrl = typeof lookup?.payloadUrl === "string" ? lookup.payloadUrl.trim() : "";
      if (payloadUrl) {
        return payloadUrl;
      }
      await sleep(50);
    }
    return null;
  }

  function chromeApplySibling(resourceUrl, segment) {
    const raw = String(resourceUrl).trim();
    try {
      const u = new URL(raw);
      let path = u.pathname.replace(/\/+$/, "") || "/";
      if (/\/payload$/i.test(path)) {
        u.pathname = `${path.replace(/\/payload$/i, "")}/${segment}`;
        return u.toString();
      }
      const baseMatch = path.match(/^(.+\/api\/chrome-apply\/[^/]+)$/i);
      if (baseMatch) {
        u.pathname = `${baseMatch[1]}/${segment}`;
        return u.toString();
      }
    } catch { }
    return raw.replace(/\/payload\/?(\?.*)?$/i, `/${segment}$1`);
  }

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const demographicPattern = /\b(pronouns?|race|ethnicity|gender|disabilit(?:y|ies)|veteran|eeo|equal opportunity|hispanic|latino|self identify|self-identify)\b/i;
  const optOutPattern = /\b(do not wish|don't wish|do not want|don't want|prefer not|decline|choose not|not disclose|no answer|wish not)\b/i;
  let forcedInterrupt = null;

  let elementRegistry = new Map();
  let cachedInteractiveActions = [];
  let cachedApplyAdvancingIds = [];
  let cachedPreApplyPhase = false;
  let cachedAuthGatePhase = false;
  let cachedClickLayout = null;

  function extractHiddenApplyUrl() {
    const chunks = [];
    if (Array.isArray(window.__next_f)) {
      for (const entry of window.__next_f) {
        if (Array.isArray(entry) && entry.length >= 2) {
          chunks.push(String(entry[1] ?? ""));
        }
      }
    }
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent || "";
      if (text.includes("externUrl")) chunks.push(text);
    }
    const pattern = /\\?"externUrl\\?"\\?\s*:\s*\\?"(https?:[^"\\]+)/gi;
    for (const chunk of chunks) {
      pattern.lastIndex = 0;
      const match = pattern.exec(chunk);
      if (match) {
        try { return new URL(match[1].replace(/\\\//g, "/")).toString(); } catch { }
      }
    }
    return null;
  }

  const SITE_PASSWORD_KEY = "jobmateWorkdayPassword";

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const last = chrome.runtime.lastError;
        if (last) { reject(new Error(last.message || "Storage read failed")); return; }
        resolve(result);
      });
    });
  }

  function storageSet(items) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        const last = chrome.runtime.lastError;
        if (last) { reject(new Error(last.message || "Storage write failed")); return; }
        resolve();
      });
    });
  }

  function pickRandomChar(chars) {
    return chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  }

  function generateSitePassword() {
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const special = "!@#$%&*";
    const all = lower + upper + digits + special;
    const chars = [pickRandomChar(lower), pickRandomChar(upper), pickRandomChar(digits), pickRandomChar(special)];
    for (let i = 0; i < 16; i++) chars.push(pickRandomChar(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }

  async function getSitePassword() {
    const stored = await storageGet(SITE_PASSWORD_KEY);
    const existing = typeof stored[SITE_PASSWORD_KEY] === "string" ? stored[SITE_PASSWORD_KEY].trim() : "";
    if (existing) return existing;
    const generated = generateSitePassword();
    await storageSet({ [SITE_PASSWORD_KEY]: generated });
    return generated;
  }

  function splitFullName(fullName) {
    const parts = clean(fullName).split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: "", last: "" };
    if (parts.length === 1) return { first: parts[0], last: parts[0] };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }

  function normalizeHref(url) {
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}${parsed.search}`;
    } catch {
      return String(url || "").trim();
    }
  }

  function resolveHref(node) {
    function hrefFrom(el) {
      const href = el.getAttribute("href");
      if (!href || href === "#" || href.startsWith("javascript:")) return null;
      try { return new URL(href, location.href).toString(); } catch { return null; }
    }
    return hrefFrom(node)
      || (node.closest("a[href]") ? hrefFrom(node.closest("a[href]")) : null)
      || (node.querySelector("a[href]") ? hrefFrom(node.querySelector("a[href]")) : null);
  }


  function pageHostName() {
    try {
      return location.hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function isBlockedApplyAction(node, href, hiddenApplyUrl) {
    if (!href || !applySessionTargetUrl) return false;
    const anchors = getApplyAnchors(hiddenApplyUrl);
    if (hasLeftTargetListing && isReturnToListingUrl(href, applySessionTargetUrl, location.href)) {
      return true;
    }
    if (applySessionTargetUrl && isOffTargetJobUrl(href, anchors, location.href)) {
      return true;
    }
    return false;
  }

  function navigateNow(href, hiddenApplyUrl) {
    if (!href || normalizeHref(href) === normalizeHref(location.href)) {
      return false;
    }
    if (applySessionTargetUrl) {
      const anchors = getApplyAnchors(hiddenApplyUrl ?? extractHiddenApplyUrl());
      if (hasLeftTargetListing && isReturnToListingUrl(href, applySessionTargetUrl, location.href)) {
        return false;
      }
      if (isOffTargetJobUrl(href, anchors, location.href)) {
        return false;
      }
    }
    location.assign(href);
    return true;
  }

  function assertApplyIntent(elementId, action) {
    if (!cachedPreApplyPhase && !cachedAuthGatePhase) return true;
    if (action?.coords || action?.ocrBlock) return true;
    if (!elementId) return true;
    if (action?.tool === "navigate") return true;
    if (!cachedApplyAdvancingIds.length) return true;
    return cachedApplyAdvancingIds.includes(elementId);
  }

  function backendNodeIdFromElementId(elementId) {
    const raw = String(elementId || "");
    if (!raw.startsWith("ax_")) return null;
    const parsed = Number(raw.slice(3));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  async function clickViaCdp(elementId, elemEntry) {
    const backendNodeId = elemEntry?.backendNodeId ?? backendNodeIdFromElementId(elementId);
    if (!backendNodeId) return null;
    return extensionMessage({ type: "JOBMATE_CDP_CLICK", backendNodeId, elementId });
  }

  function blockCenterClientPoint(ocrBlock) {
    const nx = (Number(ocrBlock.x0) + Number(ocrBlock.x1)) / 2;
    const ny = (Number(ocrBlock.y0) + Number(ocrBlock.y1)) / 2;
    return normPointToClient(nx, ny);
  }

  function normPointToClient(nx, ny) {
    const layout = cachedClickLayout;
    const vw = layout?.viewportWidth > 0 ? layout.viewportWidth : window.innerWidth;
    const vh = layout?.viewportHeight > 0 ? layout.viewportHeight : window.innerHeight;
    const x = (nx / 1000) * vw;
    const y = (ny / 1000) * vh;
    return { x, y };
  }

  function normCoordsToClient(coords, ocrBlock) {
    if (ocrBlock) return blockCenterClientPoint(ocrBlock);
    return normPointToClient(Number(coords.x), Number(coords.y));
  }

  function showVirtualMouse(x, y) {
    const ring = document.createElement("div");
    ring.setAttribute("data-jobmate-virtual-mouse", "1");
    Object.assign(ring.style, {
      position: "fixed",
      left: `${x - 12}px`,
      top: `${y - 12}px`,
      width: "24px",
      height: "24px",
      borderRadius: "50%",
      border: "2px solid #fff",
      background: "rgba(255, 59, 48, 0.75)",
      boxShadow: "0 0 12px rgba(255, 59, 48, 0.6)",
      zIndex: "2147483647",
      pointerEvents: "none",
      transition: "transform 0.15s ease, opacity 0.35s ease"
    });
    document.documentElement.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = "scale(0.65)";
      ring.style.opacity = "0.85";
    });
    setTimeout(() => {
      ring.style.opacity = "0";
      setTimeout(() => ring.remove(), 350);
    }, 450);
  }

  async function clickViaCoords(coords, ocrBlock) {
    if (!coords && !ocrBlock) return null;
    if (coords && (!Number.isFinite(Number(coords.x)) || !Number.isFinite(Number(coords.y))) && !ocrBlock) {
      return null;
    }
    if (cachedClickLayout && Number.isFinite(Number(cachedClickLayout.scrollX)) && Number.isFinite(Number(cachedClickLayout.scrollY))) {
      window.scrollTo(Number(cachedClickLayout.scrollX), Number(cachedClickLayout.scrollY));
      await sleep(50);
    }
    const { x, y } = normCoordsToClient(coords, ocrBlock);
    if (isFileUploadPoint(x, y)) {
      return { ok: false, error: "file_upload_target" };
    }
    showVirtualMouse(x, y);
    await sleep(80);
    const cdp = await extensionMessage({
      type: "JOBMATE_COORD_CLICK",
      coords,
      clientX: x,
      clientY: y,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
    if (!cdp?.ok) return { ok: false, error: cdp?.error || "cdp_click_failed" };
    return { ok: true, x, y };
  }

  async function activateElement(payloadUrl, elementId, elements, actionMeta) {
    if (actionMeta.action?.coords || actionMeta.action?.ocrBlock) {
      if (!assertApplyIntent(null, actionMeta.action)) {
        return false;
      }
      const coordLabel = actionMeta.action.ocrBlock
        ? `ocr "${String(actionMeta.action.ocrBlock.text || "").slice(0, 40)}"`
        : `coord ${actionMeta.action.coords.x},${actionMeta.action.coords.y}`;
      statusPanel(actionMeta.step, actionMeta.maxSteps, {
        ...actionMeta.action,
        elementId: coordLabel
      });
      const coordClick = await clickViaCoords(actionMeta.action.coords, actionMeta.action.ocrBlock);
      if (coordClick?.ok) {
        await sleep(400);
        return true;
      }
      return false;
    }

    if (!assertApplyIntent(elementId, actionMeta.action)) {
      return false;
    }

    const elemEntry =
      elements.find((e) => e.elementId === elementId) ||
      cachedInteractiveActions.find((e) => e.elementId === elementId);
    const node = nodeByElementId(elementId);
    const elemHref = elemEntry?.href || elemEntry?.url || (node ? resolveHref(node) : "") || "";
    const elemText = elemEntry?.text || elemEntry?.name || (node ? clean(node.textContent || "") : "");
    if (elemHref && applySessionTargetUrl && isBlockedApplyAction(null, elemHref, extractHiddenApplyUrl())) {
      return false;
    }
    statusPanel(actionMeta.step, actionMeta.maxSteps, {
      ...actionMeta.action,
      elementId: `${elementId} "${elemText.slice(0, 40)}"`
    });

    const anchors = getApplyAnchors(extractHiddenApplyUrl());
    const stemChildUrl =
      actionMeta.action?.url ||
      (elemHref ? resolveActionUrl(elemHref, location.href) : "");
    if (stemChildUrl && isStemChildApplyPath(stemChildUrl, anchors, location.href)) {
      if (navigateNow(stemChildUrl, extractHiddenApplyUrl())) return "navigated";
    }

    const cdpClick = await clickViaCdp(elementId, elemEntry);
    if (cdpClick?.ok) {
      const href = cdpClick.href || elemHref || null;
      if (href && navigateNow(href, extractHiddenApplyUrl())) return "navigated";
      await sleep(300);
      return true;
    }

    if (!node) return false;

    if (actionMeta.action?.value && (node.tagName === "SELECT" || node.getAttribute("role") === "combobox" || node.getAttribute("role") === "listbox")) {
      await fillDropdownField(
        { node, field: { type: "select", label: elemText || nearbyLabel(node) } },
        actionMeta.action.value
      );
      await sleep(300);
      return true;
    }

    const href = resolveHref(node) || elemHref || null;
    if (href) {
      if (node.tagName === "A") node.setAttribute("target", "_self");
      if (navigateNow(href, extractHiddenApplyUrl())) return "navigated";
    }

    if (actionMeta.action?.tool === "submit" || String(node.type || node.getAttribute("type") || "").toLowerCase() === "submit") {
      submitViaEnter(node);
      await sleep(300);
      return true;
    }

    if (opensFileChooser(node)) {
      return false;
    }

    try {
      node.scrollIntoView({ block: "center", inline: "center" });
      node.focus();
      node.click();
    } catch {
      return false;
    }
    await sleep(300);
    return true;
  }

  function nodeByElementId(elementId) {
    if (elementRegistry.has(elementId)) return elementRegistry.get(elementId);
    if (!String(elementId || "").startsWith("ax_")) return null;
    const action = cachedInteractiveActions.find((a) => a.elementId === elementId);
    const node = findDomNodeForA11yAction(action);
    if (node) elementRegistry.set(elementId, node);
    return node || null;
  }

  async function waitForPageLoad() {
    const deadline = Date.now() + 15000;
    while (document.readyState !== "complete" && Date.now() < deadline) {
      await sleep(200);
    }
    let lastHtml = document.body?.innerHTML?.length ?? 0;
    let stable = 0;
    while (stable < 4 && Date.now() < deadline) {
      await sleep(400);
      const cur = document.body?.innerHTML?.length ?? 0;
      if (cur === lastHtml) stable++;
      else { stable = 0; lastHtml = cur; }
    }
    const interactiveDeadline = Date.now() + 5000;
    while (Date.now() < interactiveDeadline) {
      const buttons = document.querySelectorAll('button, a[href], [role="button"], input[type="submit"]');
      if (buttons.length > 0) break;
      await sleep(300);
    }
  }


  function isActionRendered(node) {
    if (!node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    return true;
  }

  function actionText(node) {
    const attrs = clean(
      [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("value"), node.getAttribute("data-testid")]
        .filter(Boolean)
        .join(" ")
    );
    if (attrs) return attrs.slice(0, 120);
    for (const img of node.querySelectorAll?.("img[alt]") || []) {
      const alt = clean(img.getAttribute("alt") || "");
      if (alt) return alt.slice(0, 120);
    }
    const own = clean(
      Array.from(node.childNodes)
        .map((n) => {
          if (n.nodeType === Node.TEXT_NODE) return n.textContent || "";
          if (n.nodeType === Node.ELEMENT_NODE && n.childElementCount === 0) return n.textContent || "";
          return "";
        })
        .join(" ")
    );
    if (own) return own.slice(0, 120);
    return clean(node.textContent || "").slice(0, 120);
  }

  function axRoleSelectors(role) {
    switch (String(role || "").toLowerCase()) {
      case "link":
        return 'a, [role="link"]';
      case "button":
        return 'button, [role="button"], input[type="button"], input[type="submit"]';
      case "tab":
        return '[role="tab"]';
      case "menuitem":
        return '[role="menuitem"]';
      case "menuitemcheckbox":
        return '[role="menuitemcheckbox"]';
      case "menuitemradio":
        return '[role="menuitemradio"]';
      default:
        return `[role="${role}"]`;
    }
  }

  function accessibleNameMatches(node, name) {
    const a = norm(actionText(node));
    const b = norm(name);
    if (!a || !b) return false;
    return a === b;
  }

  function hrefPathFromUrl(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch {
      return "";
    }
  }

  function findDomNodeForA11yAction(action) {
    if (!action) return null;
    const role = String(action.role || action.tag || "").toLowerCase();
    const name = action.name || action.text || "";
    const axUrl = action.url || action.href || "";
    const selector = axRoleSelectors(role);
    const candidates = [];

    for (const root of fieldRoots()) {
      for (const node of queryDeep(selector, root)) {
        if (!isActionRendered(node)) continue;
        if (opensFileChooser(node)) continue;
        if (!accessibleNameMatches(node, name)) continue;

        const href = resolveHref(node) || node.getAttribute("href") || "";
        if (href && applySessionTargetUrl && isBlockedApplyAction(node, href, extractHiddenApplyUrl())) continue;

        if (role === "link" && axUrl) {
          const nodeHref = href || axUrl;
          try {
            const nodeResolved = normalizeHref(new URL(nodeHref, location.href).toString());
            const axResolved = normalizeHref(new URL(axUrl, location.href).toString());
            if (nodeResolved !== axResolved && hrefPathFromUrl(href) !== hrefPathFromUrl(axUrl)) continue;
          } catch {
            continue;
          }
        }

        candidates.push(node);
      }
    }

    return candidates.find((node) => !candidates.some((other) => other !== node && node.contains(other))) || null;
  }

  async function forcePageRescan(hiddenApplyUrl) {
    const hidden = hiddenApplyUrl ?? extractHiddenApplyUrl();
    await sleep(400);
    const scrollTargets = [
      0,
      Math.floor(window.innerHeight * 0.5),
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    ];

    for (const y of scrollTargets) {
      window.scrollTo(0, y);
      await sleep(250);
    }

    window.scrollTo(0, 0);
    await sleep(300);

    let best = collectPageElements(hidden);
    const dialogSelector =
      '[role="dialog"], [role="alertdialog"], dialog, .modal, [class*="modal"], [class*="dialog"], [aria-modal="true"]';

    for (let w = 0; w < 8; w++) {
      const current = collectPageElements(hidden);

      if (
        current.fieldItems.length > best.fieldItems.length ||
        current.elements.length > best.elements.length
      ) {
        best = current;
      }

      if (best.fieldItems.length > 0) {
        break;
      }

      if (document.querySelector(dialogSelector)) {
        await sleep(400);
        continue;
      }

      await sleep(300);
    }

    const rescanned = collectPageElements(hidden);

    if (rescanned.elements.length > best.elements.length || rescanned.fieldItems.length > best.fieldItems.length) {
      best = rescanned;
    }

    return best;
  }

  async function tryUpgradeWaitAction(step, history, hiddenApplyUrl, blockedElementIds) {
    const rescan = await forcePageRescan(hiddenApplyUrl);

    if (rescan.fieldItems.length > 0) {
      return { rescanFields: true };
    }

    const retry = await callStep(step, history, hiddenApplyUrl, rescan.elements, blockedElementIds);

    if (retry.tool === "wait") {
      return {};
    }

    return { action: retry };
  }

  function collectDomActions(hiddenApplyUrl) {
    const hidden = hiddenApplyUrl ?? extractHiddenApplyUrl();
    const actions = [];
    let actionSeq = 0;
    const selectors = 'button, a[href], [role="button"], [role="link"], input[type="submit"], input[type="button"]';
    for (const root of fieldRoots()) {
      for (const node of queryDeep(selectors, root)) {
        if (!isActionRendered(node)) continue;
        if (opensFileChooser(node)) continue;
        const text = actionText(node);
        if (!text) continue;
        const href = resolveHref(node) || "";
        if (href && applySessionTargetUrl && isBlockedApplyAction(node, href, hidden)) continue;
        const tag = node.tagName?.toLowerCase() || String(node.getAttribute("role") || "button").toLowerCase();
        actionSeq += 1;
        const elementId = `dom_${actionSeq}`;
        elementRegistry.set(elementId, node);
        actions.push({
          elementId,
          type: "action",
          tag,
          role: node.getAttribute("role") || tag,
          text,
          href,
          name: text
        });
      }
    }
    return actions;
  }

  function collectPageElements(hiddenApplyUrl) {
    elementRegistry = new Map();
    const elements = [];

    const fieldItems = controls();
    for (const item of fieldItems) {
      elementRegistry.set(item.field.fieldId, item.node);
      elements.push({
        elementId: item.field.fieldId,
        type: "field",
        tag: item.node.tagName.toLowerCase(),
        text: item.field.label,
        fieldType: item.field.type,
        label: item.field.label,
        required: item.field.required,
        options: item.field.options
      });
    }

    elements.push(...collectDomActions(hiddenApplyUrl));

    return { elements, fieldItems };
  }

  function clearActionOverlays() {
    for (const node of document.querySelectorAll(".jobmate-action-overlay")) {
      node.remove();
    }
  }

  async function callStep(step, history, hiddenApplyUrl, elements, blockedElementIds) {
    clearActionOverlays();
    const reply = await extensionMessage({
      type: "JOBMATE_ANALYZE_PAGE",
      pageUrl: location.href,
      pageText: clean(document.body?.textContent || "").slice(0, 2500),
      stepIndex: step,
      history,
      hiddenApplyUrl: hiddenApplyUrl || null,
      hasLeftTargetListing,
      elements,
      blockedElementIds: [...blockedElementIds],
      overlayMap: [],
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    });
    if (!reply?.ok) throw new Error(reply?.error || "Analyze failed.");
    if (Array.isArray(reply.interactiveActions)) {
      cachedInteractiveActions = reply.interactiveActions;
    }
    cachedApplyAdvancingIds = Array.isArray(reply.applyAdvancingIds) ? reply.applyAdvancingIds : [];
    cachedPreApplyPhase = Boolean(reply.preApplyPhase);
    cachedAuthGatePhase = Boolean(reply.authGatePhase);
    if (reply.clickLayout && Number(reply.clickLayout.viewportWidth) > 0 && Number(reply.clickLayout.viewportHeight) > 0) {
      cachedClickLayout = reply.clickLayout;
    }
    return reply.action;
  }

  function collectValidationErrors() {
    const texts = [];
    for (const node of document.querySelectorAll('[aria-invalid="true"], [aria-describedby], .error, .field-error, .invalid, .has-error, [data-error]')) {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 300) texts.push(t);
    }
    for (const node of document.querySelectorAll('[role="alert"], [role="status"]')) {
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length < 300) texts.push(t);
    }
    return [...new Set(texts)].slice(0, 20);
  }

  function fieldValueForValidation(item) {
    const node = item.node;
    if (!node) return "";
    const tag = node.tagName?.toLowerCase();
    if (tag === "select") {
      const opt = node.selectedOptions?.[0];
      return clean(opt?.label || opt?.text || opt?.value || node.value || "");
    }
    if (item.field.type === "radio" || item.field.type === "checkbox") {
      const name = node.getAttribute("name");
      const group = name
        ? Array.from(document.querySelectorAll(`input[type="${item.field.type}"][name="${CSS.escape(name)}"]`))
        : [node];
      const checked = group.filter((input) => input.checked);
      return checked.map((input) => labelledText(input) || input.value).filter(Boolean).join(", ");
    }
    if (item.field.type === "contenteditable") {
      return clean(node.textContent || "");
    }
    return clean(node.value || "");
  }

  function fieldRoots() {
    const roots = [document];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument;
        if (doc) roots.push(doc);
      } catch { }
    }
    return roots;
  }

  function queryDeep(selector, root) {
    const out = [];
    for (const node of root.querySelectorAll(selector)) out.push(node);
    for (const host of root.querySelectorAll("*")) {
      if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
    }
    return out;
  }

  function advanceTreeNode(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    if (root instanceof ShadowRoot && root.host) return root.host;
    return null;
  }

  function hostLabelAttr(node) {
    let cursor = node;
    for (let i = 0; i < 8; i++) {
      if (!cursor || cursor.nodeType !== Node.ELEMENT_NODE) break;
      const attr = cursor.getAttribute("label");
      if (attr) return clean(attr);
      cursor = advanceTreeNode(cursor);
    }
    return "";
  }

  function hostContextAttr(node) {
    const parts = [];
    let cursor = node;
    for (let i = 0; i < 8; i++) {
      if (!cursor || cursor.nodeType !== Node.ELEMENT_NODE) break;
      const tag = cursor.tagName ? cursor.tagName.toLowerCase() : "";
      const dataTest = cursor.getAttribute("data-test");
      const aria = cursor.getAttribute("aria-label");
      const name = cursor.getAttribute("name");
      const accept = cursor.getAttribute("accept");
      if (tag && tag.split("-").length > 1) parts.push(tag);
      if (dataTest) parts.push(dataTest);
      if (aria) parts.push(clean(aria));
      if (name) parts.push(name);
      if (accept) parts.push(`accept entries: ${accept.split(",").filter(Boolean).length}`);
      cursor = advanceTreeNode(cursor);
    }
    return [...new Set(parts.filter(Boolean))].slice(0, 8).join(" · ").slice(0, 260);
  }

  function headingInScope(scope) {
    if (!scope || scope.nodeType !== Node.ELEMENT_NODE) return "";
    for (const sel of ["h1", "h2", "h3", "h4", "legend", "spl-typography-title"]) {
      for (const node of queryDeep(sel, scope)) {
        const text = clean(node.textContent || "");
        if (text.length > 1 && text.length < 120) return text;
      }
    }
    return "";
  }

  function fieldContext(node) {
    const parts = [];
    let cursor = node;
    for (let depth = 0; cursor && depth < 12; depth++) {
      const heading = headingInScope(cursor);
      if (heading) parts.push(heading);
      const hostLabel = cursor.getAttribute?.("label");
      if (hostLabel) parts.push(clean(hostLabel));
      cursor = advanceTreeNode(cursor);
    }
    const hostContext = hostContextAttr(node);
    if (hostContext) parts.push(hostContext);
    return [...new Set(parts.filter(Boolean))].slice(0, 5).join(" · ").slice(0, 260);
  }

  function labelledText(node) {
    const hostLabel = hostLabelAttr(node);
    const id = node.getAttribute("id");
    const scope = scopeForNode(node);
    const byFor = id ? scope.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrap = node.closest("label");
    const aria = node.getAttribute("aria-label");
    const labelledBy = clean(
      (node.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((lid) => scope.getElementById?.(lid)?.textContent || document.getElementById(lid)?.textContent || "")
        .join(" ")
    );
    return clean(hostLabel || byFor?.textContent || wrap?.textContent || aria || labelledBy || "");
  }

  function nearbyLabel(node) {
    const direct = labelledText(node);
    if (direct && direct.length > 2 && !["yes", "no", "true", "false", "type your response", "select"].includes(direct.toLowerCase())) {
      const context = fieldContext(node);
      if (context && node?.tagName === "INPUT" && String(node.type || "").toLowerCase() === "file") {
        return `${direct} — ${context}`.slice(0, 260);
      }
      return direct;
    }
    let cursor = advanceTreeNode(node);
    let bestHeading = "";
    for (let depth = 0; cursor && depth < 12; depth++) {
      const heading = headingInScope(cursor);
      if (heading && !bestHeading) bestHeading = heading;
      const legend = cursor.querySelector?.("legend");
      const label = cursor.querySelector?.("label, [class*='label'], [class*='question'], h1, h2, h3, h4, p");
      const text = clean(legend?.textContent || label?.textContent || cursor.textContent || "");
      const options = Array.from(cursor.querySelectorAll?.("input[type='radio'], input[type='checkbox']") || [])
        .map((item) => labelledText(item) || item.value).filter(Boolean);
      let candidate = text;
      for (const option of options) {
        candidate = candidate.split(option).join(" ");
      }
      candidate = clean(candidate.replace(/[✱*]/g, " "));
      if (candidate.length > 2 && !["yes", "no", "true", "false"].includes(candidate.toLowerCase())) {
        if (bestHeading && candidate.length > bestHeading.length * 2) {
          cursor = advanceTreeNode(cursor);
          continue;
        }
        if (bestHeading) return bestHeading.slice(0, 260);
        if (candidate.length <= 120) return candidate.slice(0, 260);
      }
      cursor = advanceTreeNode(cursor);
    }
    if (bestHeading) return bestHeading.slice(0, 260);
    return direct || node.getAttribute("name") || node.getAttribute("id") || node.getAttribute("placeholder") || "Field";
  }

  function isRendered(node) {
    if (!node.isConnected) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    return true;
  }

  function groupOptions(node, type) {
    const name = node.getAttribute("name");
    const group = name
      ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`))
      : [node];
    return group.map((item) => labelledText(item) || item.value).filter(Boolean);
  }

  function nodeScope(node) {
    const root = node.getRootNode();
    return root instanceof Document || root instanceof ShadowRoot ? root : document;
  }

  function structurallyNeedsSuggestionPick(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const role = String(node.getAttribute("role") || "").toLowerCase();
    if (role === "combobox") return true;
    const ariaAutocomplete = String(node.getAttribute("aria-autocomplete") || "").toLowerCase();
    if (ariaAutocomplete && ariaAutocomplete !== "none") return true;
    const listAttr = node.getAttribute("list");
    if (listAttr) {
      const scope = nodeScope(node);
      const dataList = scope.getElementById(listAttr) || scope.querySelector(`#${CSS.escape(listAttr)}`);
      if (dataList?.tagName === "DATALIST") return true;
    }
    const popupId = node.getAttribute("aria-controls") || node.getAttribute("aria-owns") || "";
    if (popupId) {
      const scope = nodeScope(node);
      const popup = scope.getElementById(popupId) || document.getElementById(popupId);
      if (popup && String(popup.getAttribute("role") || "").toLowerCase() === "listbox") return true;
    }
    let cursor = node.parentElement;
    for (let depth = 0; depth < 6 && cursor; depth++) {
      if (String(cursor.getAttribute("role") || "").toLowerCase() === "combobox") return true;
      if (cursor.parentElement) {
        cursor = cursor.parentElement;
      } else {
        const root = cursor.getRootNode();
        cursor = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return false;
  }

  function resolveFieldKind(node, type, tag) {
    if (tag === "select" || type === "select") return "select";
    if (type === "file") return "file";
    if (type === "radio" || type === "checkbox") return type;
    if (structurallyNeedsSuggestionPick(node)) return "suggestion";
    return "text";
  }

  function controls() {
    const seen = new Set();
    const items = [];
    let fieldSeq = 0;

    function pushField(node, type, tag) {
      const nameAttr = node.getAttribute("name") || "";
      const idAttr = node.id || "";
      if (/captcha/i.test(`${nameAttr} ${idAttr}`)) return;

      const key = nameAttr || idAttr || `field_${fieldSeq}`;
      const groupKey = type === "radio" || type === "checkbox" ? `${type}:${key}` : "";
      if (groupKey && seen.has(groupKey)) return;
      if (groupKey) seen.add(groupKey);

      const fieldId = `jm_${fieldSeq}_${key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60)}`;
      fieldSeq++;
      node.dataset.jobmateFieldId = fieldId;
      const lab = nearbyLabel(node);
      const ctx = fieldContext(node);
      const fieldKind = resolveFieldKind(node, type, tag);
      const needsSuggestionPick = fieldKind === "suggestion";

      items.push({
        node,
        field: {
          fieldId,
          key,
          label: lab,
          context: ctx,
          type,
          fieldKind,
          needsSuggestionPick,
          autocomplete: needsSuggestionPick,
          required:
            (node.required === true || String(node.getAttribute("aria-required") || "") === "true") ||
            /[✱*]|required/i.test(lab),
          options: node.tagName === "SELECT"
            ? Array.from(node.options).map((opt) => clean(opt.label || opt.text || opt.value)).filter(Boolean)
            : type === "radio" || type === "checkbox"
              ? groupOptions(node, type)
              : type === "select"
                ? Array.from(node.querySelectorAll('[role="option"]')).map((opt) => clean(opt.textContent || "")).filter(Boolean)
                : []
        }
      });
    }

    function isCheckboxUsable(node) {
      if (isRendered(node)) return true;
      const id = node.id;
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label && isRendered(label)) return true;
      }
      const parentLabel = node.closest("label");
      if (parentLabel && isRendered(parentLabel)) return true;
      return false;
    }

    for (const root of fieldRoots()) {
      for (const node of queryDeep("input, textarea, select", root)) {
        const tag = node.tagName.toLowerCase();
        const type = tag === "input" ? String(node.type || "text").toLowerCase() : tag;
        if (["hidden", "button", "submit", "reset", "image", "search"].includes(type)) continue;
        if (node.closest('[role="search"], search')) continue;
        if (type === "checkbox") {
          if (!isCheckboxUsable(node)) continue;
        } else if (type !== "file" && !isRendered(node)) {
          continue;
        }
        pushField(node, type, tag);
      }
    }

    for (const root of fieldRoots()) {
      for (const node of queryDeep("[contenteditable=true]", root)) {
        if (node.querySelector("[contenteditable=true]")) continue;
        if (node.querySelector("input, textarea, select")) continue;
        if (!isRendered(node)) continue;
        pushField(node, "contenteditable", "div");
      }
    }

    const ariaRoleTypeMap = {
      checkbox: "checkbox",
      radio: "radio",
      switch: "checkbox",
      textbox: "text",
      spinbutton: "number",
      combobox: "select",
      listbox: "select"
    };
    const ariaRoleSelector = Object.keys(ariaRoleTypeMap).map((r) => `[role="${r}"]`).join(",");
    const skipIfContainsNative = new Set(["combobox", "listbox", "textbox"]);

    for (const root of fieldRoots()) {
      for (const node of queryDeep(ariaRoleSelector, root)) {
        if (["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) continue;
        const role = node.getAttribute("role");
        if (skipIfContainsNative.has(role) && node.querySelector("input, textarea, select")) continue;
        if (!isRendered(node)) continue;
        pushField(node, ariaRoleTypeMap[role] || role, node.tagName.toLowerCase());
      }
    }

    return items;
  }

  function submitViaEnter(contextNode) {
    const form = contextNode?.closest?.("form") || document.querySelector("form");
    const inputs = form
      ? Array.from(form.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([disabled]), textarea:not([disabled])"))
      : [];
    const focusTarget =
      (document.activeElement && form?.contains(document.activeElement) ? document.activeElement : null) ||
      inputs.find((el) => el.type === "password") ||
      inputs[inputs.length - 1] ||
      form;

    if (!focusTarget) return;

    focusTarget.focus();

    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, view: window };
    focusTarget.dispatchEvent(new KeyboardEvent("keydown", opts));
    focusTarget.dispatchEvent(new KeyboardEvent("keypress", opts));
    focusTarget.dispatchEvent(new KeyboardEvent("keyup", opts));

    if (form && typeof form.requestSubmit === "function") {
      try { form.requestSubmit(); } catch { }
    }
  }

  function scopeForNode(node) {
    const root = node.getRootNode();
    return root instanceof Document || root instanceof ShadowRoot ? root : document;
  }

  function fileInputFromId(scope, id) {
    if (!id) return null;
    const linked = scope.querySelector(`#${CSS.escape(id)}`);
    if (linked?.tagName === "INPUT" && String(linked.type || "").toLowerCase() === "file") {
      return linked;
    }
    return null;
  }

  function associatedFileInput(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.tagName === "INPUT" && String(node.type || "").toLowerCase() === "file") {
      return node;
    }
    const scope = scopeForNode(node);
    if (node.tagName === "LABEL") {
      const byFor = fileInputFromId(scope, node.getAttribute("for"));
      if (byFor) return byFor;
      const nested = node.querySelector('input[type="file"]');
      if (nested) return nested;
    }
    const labelWrap = node.closest("label");
    if (labelWrap) {
      const nested = labelWrap.querySelector('input[type="file"]');
      if (nested) return nested;
    }
    const inTree = node.querySelector?.('input[type="file"]');
    if (inTree) return inTree;
    const asInput = node.closest?.('input[type="file"]');
    if (asInput) return asInput;
    const fieldGroup = node.closest(
      "fieldset, label, li, tr, [class*='field'], [class*='Field'], [class*='upload'], [class*='Upload'], [class*='file'], [class*='File'], [class*='attachment'], [class*='Attachment'], [data-testid*='upload'], [data-testid*='file'], [data-testid*='resume'], [data-testid*='cv']"
    );
    if (fieldGroup) {
      const nearby = fieldGroup.querySelector('input[type="file"]');
      if (nearby) return nearby;
    }
    return null;
  }

  function opensFileChooser(node) {
    return Boolean(associatedFileInput(node));
  }

  function isFileUploadNode(node) {
    if (!node) return false;
    if (node.tagName === "INPUT" && String(node.type || "").toLowerCase() === "file") return true;
    if (associatedFileInput(node)) return true;
    if (node.querySelector?.('input[type="file"]')) return true;
    return false;
  }

  function isFileUploadPoint(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest("[data-jobmate-virtual-mouse]") || el.closest("#jobmate-status")) continue;
      if (isFileUploadNode(el)) return true;
    }
    return false;
  }

  async function aggressiveClick(node) {
    if (opensFileChooser(node)) {
      return;
    }

    const savedAriaHidden = node.getAttribute("aria-hidden");
    const savedTabindex = node.getAttribute("tabindex");
    const savedDisabled = node.disabled;
    const savedAriaDisabled = node.getAttribute("aria-disabled");

    if (savedAriaHidden) node.removeAttribute("aria-hidden");
    if (savedTabindex && parseInt(savedTabindex) < 0) node.setAttribute("tabindex", "0");
    if (savedDisabled) node.disabled = false;
    if (savedAriaDisabled === "true") node.setAttribute("aria-disabled", "false");

    node.focus();

    const evOpts = { bubbles: true, cancelable: true, view: window };
    node.dispatchEvent(new PointerEvent("pointerover", evOpts));
    node.dispatchEvent(new PointerEvent("pointerenter", evOpts));
    node.dispatchEvent(new MouseEvent("mouseover", evOpts));
    node.dispatchEvent(new MouseEvent("mouseenter", evOpts));
    node.dispatchEvent(new PointerEvent("pointerdown", evOpts));
    node.dispatchEvent(new MouseEvent("mousedown", evOpts));
    node.dispatchEvent(new PointerEvent("pointerup", evOpts));
    node.dispatchEvent(new MouseEvent("mouseup", evOpts));
    node.dispatchEvent(new MouseEvent("click", evOpts));
    node.click();

    if (savedAriaHidden) node.setAttribute("aria-hidden", savedAriaHidden); else node.removeAttribute("aria-hidden");
    if (savedTabindex !== null) node.setAttribute("tabindex", savedTabindex); else node.removeAttribute("tabindex");
    if (savedDisabled) node.disabled = true;
    if (savedAriaDisabled !== null) node.setAttribute("aria-disabled", savedAriaDisabled);
  }

  async function clickNode(node) {
    await aggressiveClick(node);
  }

  function setNativeValue(node, value) {
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function replaceFieldValue(node, text, label) {
    const value = String(text ?? "");
    if (!value) {
      throw new Error(`Refusing to clear "${label || nearbyLabel(node) || "field"}".`);
    }
    setNativeValue(node, value);
  }

  async function focusField(node) {
    if (!node?.isConnected) return;
    try {
      node.scrollIntoView({ block: "center", inline: "center" });
    } catch { }
    await aggressiveClick(node);
    await sleep(120);
    try {
      node.focus();
    } catch { }
  }

  function pickSelectOption(node, answer) {
    const target = norm(answer);
    for (const opt of node.options) {
      const labels = [opt.label, opt.text, opt.value].map(norm).filter(Boolean);
      if (labels.some((label) => label === target || label.includes(target) || target.includes(label))) {
        return opt;
      }
    }
    return null;
  }

  async function findAndClickOption(answer) {
    const wanted = norm(answer);
    if (!wanted) return false;
    for (let round = 0; round < 4; round++) {
      const options = queryDeep('[role="option"], [role="menuitem"], [role="menuitemradio"], li[aria-selected], spl-list-item', document);
      for (const opt of options) {
        if (!isRendered(opt)) continue;
        const text = norm(opt.textContent || opt.getAttribute("aria-label") || "");
        if (!text) continue;
        if (text === wanted || text.includes(wanted) || wanted.includes(text)) {
          await aggressiveClick(opt);
          await sleep(150);
          return true;
        }
      }
      await sleep(200);
    }
    return false;
  }

  async function clickDropdownOptionViaOcr(answer, fieldLabel) {
    const reply = await extensionMessage({
      type: "JOBMATE_OCR_PICK_TEXT",
      targetText: answer,
      fieldLabel: fieldLabel || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      }
    });
    if (!reply?.ok || !reply.coords) return false;
    if (reply.clickLayout) cachedClickLayout = reply.clickLayout;
    const result = await clickViaCoords(reply.coords, reply.ocrBlock);
    return Boolean(result?.ok);
  }

  async function collectVisibleSuggestionOptions() {
    const options = [];
    let index = 0;
    for (const opt of queryDeep('[role="option"], [role="listbox"] li, li[aria-selected], [aria-selected="true"], [aria-selected="false"]', document)) {
      if (!isRendered(opt)) continue;
      const text = clean(opt.textContent || opt.getAttribute("aria-label") || "");
      if (!text || text.length > 200) continue;
      options.push({ index: index++, text: text.slice(0, 200), node: opt });
    }
    return options;
  }

  function suggestionFieldDiagnostics(item, node, answer, optionCount) {
    return [
      `No suggestions for "${item.field.label}".`,
      `Role: ${node.getAttribute("role") || ""}`,
      `Aria controls: ${node.getAttribute("aria-controls") || ""}`,
      `Aria expanded: ${node.getAttribute("aria-expanded") || ""}`,
      `Typed value: ${answer || ""}`,
      `Option count: ${optionCount}`,
      `Invalid: ${node.getAttribute("aria-invalid") || ""}`
    ].join(" ");
  }

  async function waitForSuggestionState(node) {
    let options = await collectVisibleSuggestionOptions();
    for (let round = 0; round < 6 && !options.length; round++) {
      const expanded = node.getAttribute("aria-expanded");
      const active = node.getAttribute("aria-activedescendant");
      if (expanded === "true" || active) break;
      await sleep(150);
      options = await collectVisibleSuggestionOptions();
    }
    return options;
  }

  async function commitAriaSuggestionField(item, answer, optionCount) {
    const node = item.node;
    if (!structurallyNeedsSuggestionPick(node)) {
      throw new Error(suggestionFieldDiagnostics(item, node, answer, optionCount));
    }
    const keyReply = await extensionMessage({ type: "JOBMATE_CDP_DISPATCH_KEYS", keys: ["ArrowDown", "Enter"] });
    if (!keyReply?.ok) {
      throw new Error(keyReply?.error || `Could not commit suggestion for "${item.field.label}".`);
    }
    await sleep(300);
    if (node.getAttribute("aria-invalid") === "true") {
      throw new Error(`Validation failed for "${item.field.label}".`);
    }
  }

  async function fillSuggestionField(item, answer) {
    const node = item.node;
    await focusField(node);
    replaceFieldValue(node, answer, item.field.label);
    await sleep(400);
    let options = await waitForSuggestionState(node);
    if (!options.length) {
      await commitAriaSuggestionField(item, answer, options.length);
      return;
    }
    const pickReply = await extensionMessage({
      type: "JOBMATE_PICK_SUGGESTION_OPTION",
      fieldLabel: item.field.label,
      desiredAnswer: answer,
      options: options.map(({ index, text }) => ({ index, text }))
    });
    if (!pickReply?.ok) {
      throw new Error(pickReply?.error || `Could not pick suggestion for "${item.field.label}".`);
    }
    if (pickReply.manualEntry) {
      const manualIdx = Number(pickReply.optionIndex);
      const manualOpt = Number.isFinite(manualIdx)
        ? options.find((option) => option.index === manualIdx)
        : options[options.length - 1];
      if (manualOpt) {
        await aggressiveClick(manualOpt.node);
        await sleep(200);
      }
      replaceFieldValue(node, answer, item.field.label);
      await sleep(200);
    } else if (!pickReply.typeAsFreeText) {
      const idx = Number(pickReply.optionIndex);
      const picked = options.find((option) => option.index === idx);
      if (!picked) throw new Error(`Invalid suggestion index for "${item.field.label}".`);
      await aggressiveClick(picked.node);
      await sleep(200);
    }
    if (node.getAttribute("aria-invalid") === "true") {
      throw new Error(`Validation failed for "${item.field.label}".`);
    }
  }

  async function fillDropdownField(item, answer) {
    const node = item.node;
    if (node.tagName === "SELECT") {
      await focusField(node);
      const picked = pickSelectOption(node, answer);
      if (!picked) throw new Error(`No matching option for "${item.field.label}".`);
      node.value = picked.value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    await focusField(node);
    await sleep(200);
    if (await findAndClickOption(answer)) return;
    if (await clickDropdownOptionViaOcr(answer, item.field.label)) return;
    throw new Error(`Could not select "${answer}" for "${item.field.label}".`);
  }

  async function fillTextField(node, answer) {
    await focusField(node);
    await typeText(node, answer);
  }

  async function typeText(node, text) {
    node.focus();
    replaceFieldValue(node, text, nearbyLabel(node));
  }

  function isDemographicField(field) {
    return demographicPattern.test(field.label);
  }

  function optionMatches(wantedParts, label, value) {
    const lab = norm(`${label} ${value}`);
    for (const part of wantedParts) {
      if (!part) continue;
      if (lab === part || lab.includes(part) || part.includes(lab)) return true;
      if (part === "yes" && /\b(yes|true|agree|accept|accepted|authorized|eligible|confirm|consent)\b/.test(lab)) {
        return true;
      }
      if (part === "no" && /\b(no|false|not eligible|without|decline|do not|don't)\b/.test(lab)) {
        return true;
      }
    }
    return false;
  }

  function fieldLooksEmpty(item) {
    const node = item.node;
    const type = item.field.type;
    if (type === "file") return false;
    if (type === "checkbox") {
      if (node.tagName === "INPUT") return !node.checked;
      return node.getAttribute("aria-checked") !== "true";
    }
    if (type === "radio") {
      if (node.tagName !== "INPUT") return node.getAttribute("aria-checked") !== "true";
      const name = node.getAttribute("name");
      const group = name
        ? Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`))
        : [node];
      return !group.some((entry) => entry.checked);
    }
    if (node.tagName === "SELECT") {
      const value = String(node.value || "").trim();
      if (!value) return true;
      const selected = node.selectedOptions?.[0];
      const label = norm(selected?.label || selected?.text || value);
      return !label || label === "select" || label === "choose" || label === "please select";
    }
    if (type === "contenteditable") return !clean(node.textContent || "");
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)) return !clean(node.textContent || "");
    return !String(node.value ?? "").trim();
  }

  function choiceClickTarget(input) {
    if (!["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(input.tagName)) {
      return input;
    }
    const id = input.id;
    if (id) {
      const linked = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (linked) return linked;
    }
    const wrapped = input.closest("label");
    if (wrapped) return wrapped;
    return input;
  }

  function nativeSetChecked(input, checked) {
    if (input.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
      if (setter) {
        setter.call(input, checked);
      } else {
        input.checked = checked;
      }
    }
    if (input.getAttribute("role") === "checkbox" || input.getAttribute("role") === "radio") {
      input.setAttribute("aria-checked", checked ? "true" : "false");
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function activateChoice(input, checked) {
    const target = choiceClickTarget(input);
    await aggressiveClick(target);
    const role = input.getAttribute("role");
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const kbOpts = { bubbles: true, cancelable: true, key: " ", code: "Space", keyCode: 32 };
      input.dispatchEvent(new KeyboardEvent("keydown", kbOpts));
      input.dispatchEvent(new KeyboardEvent("keyup", kbOpts));
    }
    if (checked !== undefined) {
      nativeSetChecked(input, checked);
    }
  }

  async function choose(node, answer, multi) {
    const name = node.getAttribute("name");
    const role = node.getAttribute("role");
    const inputType = node.type || role || "checkbox";
    const group = name && node.tagName === "INPUT"
      ? Array.from(document.querySelectorAll(`input[type="${node.type}"][name="${CSS.escape(name)}"]`))
      : role === "radio" || role === "checkbox"
        ? [node]
        : name
          ? Array.from(document.querySelectorAll(`input[type="${inputType}"][name="${CSS.escape(name)}"]`))
          : [node];
    const wanted = answer.split(/[\n,;|]/).map(norm).filter(Boolean);
    for (const item of group) {
      const label = labelledText(item);
      const match = optionMatches(wanted, label, item.value);
      if (match) {
        item.focus();
        if (!item.checked) await activateChoice(item, true);
        if (!multi) return;
      }
    }
  }

  async function checkNonDemographicCheckboxes(fieldItems) {
    for (const item of fieldItems) {
      if (item.field.type !== "checkbox") continue;
      if (isDemographicField(item.field)) continue;
      if (!fieldLooksEmpty(item)) continue;
      item.node.focus();
      await activateChoice(item.node, true);
    }
  }

  function optOutAnswer(field) {
    if (!field.required || !["radio", "checkbox", "select"].includes(field.type) || !isDemographicField(field)) {
      return "";
    }
    return field.options.find((option) => optOutPattern.test(option)) || "";
  }

  function isCoverLetterLabel(label) {
    const token = norm(label);
    if (!token) return false;
    if (token.includes("cover") || token.includes("motivation letter") || token.includes("letter of interest")) {
      return true;
    }
    if (token.includes("letter") && !token.includes("newsletter")) {
      return true;
    }
    if (
      token.includes("message to the hiring") ||
      token.includes("message to the recruitment") ||
      token.includes("why do you want") ||
      token.includes("why are you interested")
    ) {
      return true;
    }
    return false;
  }

  function isResumeLabel(label) {
    const token = norm(label);
    if (!token) return false;
    if (token === "cv" || /^cv\b/.test(token) || /\bcv\b/.test(token)) return true;
    return (
      token.includes("resume") ||
      token.includes("curriculum vitae") ||
      token.includes("lebenslauf") ||
      token.includes("curriculum")
    );
  }

  function collectAllFileInputs() {
    const seen = new Set();
    const inputs = [];

    for (const root of fieldRoots()) {
      for (const node of queryDeep('input[type="file"]', root)) {
        if (seen.has(node)) continue;
        seen.add(node);
        inputs.push(node);
      }
    }

    return inputs;
  }

  function syncFileFieldItems(fieldItems) {
    const items = [...fieldItems];
    const known = new Set(fieldItems.map((item) => item.node));
    let fieldSeq = fieldItems.length;

    for (const input of collectAllFileInputs()) {
      if (known.has(input)) continue;
      const nameAttr = input.getAttribute("name") || "";
      const idAttr = input.id || "";
      const key = nameAttr || idAttr || `file_${fieldSeq}`;
      const fieldId = input.dataset.jobmateFieldId || `jm_${fieldSeq}_${key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60)}`;
      fieldSeq += 1;
      input.dataset.jobmateFieldId = fieldId;
      const fileLabel = nearbyLabel(input);
      items.push({
        node: input,
        field: {
          fieldId,
          key,
          label: fileLabel,
          context: fieldContext(input),
          type: "file",
          fieldKind: "file",
          needsSuggestionPick: false,
          required:
            input.required === true ||
            String(input.getAttribute("aria-required") || "") === "true" ||
            /[✱*]|required/i.test(fileLabel),
          options: []
        }
      });
    }

    return items;
  }

  function resolveFileAttachmentIds(fieldItems, resumeFieldIds, coverLetterFieldIds) {
    const fileIds = new Set(fieldItems.filter((item) => item.field.type === "file").map((item) => item.field.fieldId));
    const resume = [...new Set(resumeFieldIds || [])].filter((id) => fileIds.has(id));
    const cover = [...new Set(coverLetterFieldIds || [])].filter((id) => fileIds.has(id));
    for (const id of resume) {
      if (cover.includes(id)) {
        throw new Error("The same file field was marked as both CV and cover letter.");
      }
    }
    return { resumeFieldIds: resume, coverLetterFieldIds: cover };
  }

  function collectResumeInputs(fieldItems, resumeFieldIds) {
    const resumeSet = new Set(resumeFieldIds || []);
    if (!resumeSet.size) return [];
    return fieldItems
      .filter((item) => item.field.type === "file" && resumeSet.has(item.field.fieldId))
      .map((item) => item.node);
  }

  function fileInputHasResume(input) {
    const files = input.files;
    return Boolean(files && files.length > 0);
  }

  function resumeUploadLooksComplete(input, payload) {
    if (fileInputHasResume(input)) return true;
    const section = input.closest("section, fieldset, form, li, article, div, label") || input.parentElement;
    const text = clean(section?.textContent || "").slice(0, 800).toLowerCase();
    const uploadName = String(payload?.resumeUpload?.name || "").trim().toLowerCase();
    if (uploadName && text.includes(uploadName)) return true;
    return false;
  }

  function shadowPiercingClosest(node, selector) {
    let current = node;
    while (current) {
      if (current.matches && current.matches(selector)) return current;
      if (current.parentElement) {
        current = current.parentElement;
      } else if (current.parentNode && current.parentNode.host) {
        current = current.parentNode.host;
      } else {
        break;
      }
    }
    return null;
  }

  function findDropZone(target) {
    const uploadSelectors = [
      "[class*='upload']", "[class*='drop']", "[class*='Upload']", "[class*='Drop']",
      "[class*='attachment']", "[class*='Attachment']", "[class*='file-input']",
      "[data-drop]", "[droppable]", "[ondrop]"
    ];
    for (const sel of uploadSelectors) {
      const found = shadowPiercingClosest(target, sel);
      if (found) return found;
    }
    const label = shadowPiercingClosest(target, "label");
    if (label) return label;
    let host = target.parentElement;
    for (let depth = 0; depth < 6 && host; depth++) {
      if (!host.parentElement && host.parentNode?.host) host = host.parentNode.host;
      else host = host.parentElement;
      if (host && host !== document.body && host !== document.documentElement) return host;
    }
    return target;
  }

  function fileInputClickPoint(input) {
    const rect = input.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    const zone = findDropZone(input);
    const zoneRect = zone.getBoundingClientRect();
    if (zoneRect.width > 0 || zoneRect.height > 0) {
      return { x: zoneRect.x + zoneRect.width / 2, y: zoneRect.y + zoneRect.height / 2 };
    }
    return { x: 0, y: 0 };
  }

  async function forceAttachResumeToInput(input, file, fieldLabel, uploadMeta) {
    if (!uploadMeta?.base64) {
      return {
        ok: false,
        error: "missing_file_data",
        stage: "validate_file",
        fieldId: input.dataset.jobmateFieldId || "",
        backendNodeId: null,
        fileCount: null
      };
    }

    input.dataset.jobmateCdpFileTarget = "1";
    const point = fileInputClickPoint(input);
    try {
      const reply = await extensionMessage({
        type: "JOBMATE_CDP_SET_FILE",
        fieldId: input.dataset.jobmateFieldId || "",
        fieldLabel: fieldLabel || nearbyLabel(input),
        fieldContext: fieldContext(input),
        clientX: point.x,
        clientY: point.y,
        base64: uploadMeta.base64,
        mimeType: uploadMeta.mimeType || file?.type,
        filename: uploadMeta.name || file?.name
      });
      const ok = Boolean(reply?.ok && fileInputHasResume(input));
      if (ok) return { ok: true, ...reply };
      if (reply?.ok) {
        return { ok: true, ...reply };
      }
      return {
        ok: false,
        error: reply?.error || "cdp_file_set_failed",
        stage: reply?.stage || "cdp_file_set",
        fieldId: reply?.fieldId || input.dataset.jobmateFieldId || "",
        backendNodeId: reply?.backendNodeId ?? null,
        fileCount: reply?.fileCount ?? null
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        stage: "extension_message",
        fieldId: input.dataset.jobmateFieldId || "",
        backendNodeId: null,
        fileCount: null
      };
    } finally {
      delete input.dataset.jobmateCdpFileTarget;
    }
  }

  function fileAttachFailureLines(title, input, fieldItem, result) {
    const label = fieldItem?.field?.label || nearbyLabel(input) || "file input";
    const context = fieldItem?.field?.context || fieldContext(input) || "";
    const lines = [
      title,
      `Field: ${label}`,
      context ? `Context: ${context}` : "",
      `Stage: ${result?.stage || "unknown"}`,
      `Error: ${result?.error || "unknown"}`,
      `Field ID: ${result?.fieldId || input.dataset.jobmateFieldId || ""}`,
      `Backend node ID: ${result?.backendNodeId ?? "not resolved"}`,
      `File count: ${result?.fileCount ?? input.files?.length ?? "unknown"}`
    ];
    return lines.filter(Boolean);
  }

  async function verifyRunner(payloadUrl) {
    const reply = await extensionMessage({ type: "JOBMATE_APPLY_IS_RUNNER", payloadUrl }).catch(() => ({ ok: false }));
    return Boolean(reply?.ok);
  }

  function detectPageLanguage() {
    const htmlLang = (document.documentElement.lang || "").trim().toLowerCase();

    if (htmlLang) {
      return htmlLang.split("-")[0];
    }

    const metaLang = document.querySelector('meta[http-equiv="content-language"], meta[name="language"]');
    const metaValue = (metaLang?.getAttribute("content") || "").trim().toLowerCase();

    if (metaValue) {
      return metaValue.split("-")[0];
    }

    return "";
  }

  function isCoverLetterFileInput(input) {
    if (isCoverLetterLabel(nearbyLabel(input))) return true;
    const section = input.closest("section, fieldset, form, li, article, div");
    const sectionText = norm(String(section?.textContent || "").slice(0, 1500));
    if (
      !sectionText.includes("cover letter") &&
      !sectionText.includes("coverletter") &&
      !sectionText.includes("motivation letter")
    ) {
      return false;
    }
    const resumeIdx = Math.min(
      sectionText.includes("resume") ? sectionText.indexOf("resume") : Infinity,
      sectionText.includes(" cv ") ? sectionText.indexOf(" cv ") : Infinity
    );
    const coverIdx = Math.min(
      sectionText.includes("cover letter") ? sectionText.indexOf("cover letter") : Infinity,
      sectionText.includes("coverletter") ? sectionText.indexOf("coverletter") : Infinity,
      sectionText.includes("motivation letter") ? sectionText.indexOf("motivation letter") : Infinity
    );
    return coverIdx < resumeIdx;
  }

  function isCoverLetterTextField(item) {
    if (item.field.type === "file") return false;
    if (isCoverLetterLabel(item.field.label)) return true;
    const section = item.node.closest("section, fieldset, form, li, article, div");
    const sectionText = norm(String(section?.textContent || "").slice(0, 1500));
    return (
      sectionText.includes("cover letter") ||
      sectionText.includes("coverletter") ||
      sectionText.includes("motivation letter")
    );
  }

  function pageHasCoverLetterSection() {
    const blob = norm(document.body?.textContent || "");
    return blob.includes("cover letter") || blob.includes("coverletter") || blob.includes("motivation letter");
  }

  async function revealCoverLetterManualEntry() {
    const candidates = Array.from(
      document.querySelectorAll("button, a, [role='button'], [role='link'], label, span, div")
    );
    const manual = [];

    for (const node of candidates) {
      const text = clean(node.textContent || node.getAttribute("aria-label") || "");
      if (!text || text.length > 80) continue;
      if (!/\benter manually\b|\btype manually\b|\bpaste manually\b|\bwrite manually\b|\btext entry\b/i.test(text)) {
        continue;
      }

      const section = node.closest("section, fieldset, form, li, article, div") || node.parentElement;
      const sectionText = norm(String(section?.textContent || "").slice(0, 1200));
      const nearCover =
        sectionText.includes("cover") ||
        sectionText.includes("motivation") ||
        (sectionText.includes("letter") && !sectionText.includes("newsletter"));

      manual.push({ node, nearCover, sectionSize: sectionText.length });
    }

    manual.sort((a, b) => {
      if (a.nearCover !== b.nearCover) return a.nearCover ? -1 : 1;
      return a.sectionSize - b.sectionSize;
    });

    if (!manual.length) {
      return false;
    }

    if (!pageHasCoverLetterSection() && !manual.some((item) => item.nearCover)) {
      return false;
    }

    const pick = manual.find((item) => item.nearCover) || manual[0];
    await aggressiveClick(pick.node);
    await sleep(500);
    return true;
  }

  function looksLikeFilename(value) {
    return /\.(pdf|docx?|rtf|txt)$/i.test(String(value || "").trim());
  }

  function base64ToFile(upload) {
    const binary = atob(upload.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const name = String(upload.name || "resume.pdf").trim() || "resume.pdf";
    const mimeType = String(upload.mimeType || "application/pdf").trim() || "application/pdf";
    return new File([bytes], name.endsWith(".pdf") ? name : `${name}.pdf`, { type: mimeType });
  }

  async function fileToUploadMeta(file) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return {
      base64: btoa(binary),
      mimeType: file.type,
      name: file.name
    };
  }

  function classifyCoverLetterFileFields(fieldItems) {
    const coverLetterFileIds = [];
    for (const item of fieldItems) {
      if (item.field.type !== "file") continue;
      if (isCoverLetterLabel(item.field.label) || isCoverLetterFileInput(item.node)) {
        coverLetterFileIds.push(item.field.fieldId);
      }
    }
    return coverLetterFileIds;
  }

  function hasCoverLetterTextField(fieldItems) {
    return fieldItems.some((item) => isCoverLetterTextField(item));
  }

  function coverLetterUploadFile(payload) {
    if (payload.coverUpload?.base64) {
      return base64ToFile(payload.coverUpload);
    }
    const text = String(payload.coverLetterText || "").trim();
    if (!text) return null;
    return new File([text], "cover-letter.txt", { type: "text/plain" });
  }

  async function attachResumeOnce(fieldItems, payload, resumeFieldIds, coverLetterFieldIds) {
    if (payload._resumeAttachDone) return;
    if (!payload.resumeUpload?.base64) {
      const anyFileFields = fieldItems.some((item) => item.field.type === "file");
      if (anyFileFields) {
        panel(["JobMate — no CV configured", "CV file fields were found but no resume PDF is uploaded in extension settings. Go to Settings → upload your resume PDF, then restart."]);
        await sleep(4000);
      }
      return;
    }

    const resume = base64ToFile(payload.resumeUpload);
    const coverSet = new Set(coverLetterFieldIds || []);
    let targetInputs = collectResumeInputs(fieldItems, resumeFieldIds).filter((input) => {
      const item = fieldItems.find((entry) => entry.node === input);
      return item && !coverSet.has(item.field.fieldId);
    });

    if (!targetInputs.length) {
      const fileFields = fieldItems
        .filter((item) => item.field.type === "file")
        .map((item) => `${item.field.label || "file input"}${item.field.context ? ` (${item.field.context})` : ""}`)
        .slice(0, 6);
      panel(["JobMate — CV field not selected", "Gemini did not identify a CV file field.", ...fileFields]);
      await sleep(3000);
      payload._resumeAttachDone = true;
      return;
    }

    for (const input of targetInputs) {
      if (fileInputHasResume(input) || resumeUploadLooksComplete(input, payload)) continue;
      const fieldItem = fieldItems.find((entry) => entry.node === input);
      const fieldLabel = fieldItem?.field?.label || nearbyLabel(input);
      const result = await forceAttachResumeToInput(input, resume, fieldLabel, payload.resumeUpload);
      if (!result.ok) {
        panel(fileAttachFailureLines("JobMate — CV attachment failed", input, fieldItem, result));
        await sleep(3000);
      }
    }
    payload._resumeAttachDone = true;
  }

  async function attachCoverLetterFiles(fieldItems, payload, coverLetterFieldIds, resumeFieldIds) {
    if (!coverLetterFieldIds.length) return;
    const coverFile = coverLetterUploadFile(payload);
    if (!coverFile) return;
    const coverSet = new Set(coverLetterFieldIds);
    const resumeSet = new Set(resumeFieldIds || []);

    for (const item of fieldItems) {
      if (item.field.type !== "file") continue;
      const fieldId = item.field.fieldId;
      if (!coverSet.has(fieldId) || resumeSet.has(fieldId)) continue;
      const uploadMeta = payload.coverUpload?.base64
        ? payload.coverUpload
        : await fileToUploadMeta(coverFile);
      const result = await forceAttachResumeToInput(item.node, coverFile, item.field.label, uploadMeta);
      if (!result.ok) {
        panel(fileAttachFailureLines("JobMate — cover letter attachment failed", item.node, item, result));
        await sleep(3000);
      }
    }
  }

  async function fillControl(item, answer) {
    const node = item.node;
    const type = item.field.type;
    if (type === "file") return;

    if (type === "checkbox" && node.tagName !== "INPUT") {
      if (!isDemographicField(item.field) && fieldLooksEmpty(item)) {
        await activateChoice(node, true);
      }
      return;
    }

    if (type === "checkbox" && !answer && !isDemographicField(item.field)) {
      if (!node.checked) {
        await focusField(node);
        await activateChoice(node, true);
      }
      return;
    }

    if (!answer) return;

    if (type === "contenteditable") {
      await focusField(node);
      node.textContent = answer;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (type === "radio" || type === "checkbox") {
      await choose(node, answer, type === "checkbox");
      return;
    }

    if (node.tagName === "SELECT" || type === "select") {
      await fillDropdownField(item, answer);
      return;
    }

    if (item.field.needsSuggestionPick || item.field.fieldKind === "suggestion") {
      await fillSuggestionField(item, answer);
      return;
    }

    if (!["INPUT", "TEXTAREA"].includes(node.tagName)) {
      await focusField(node);
      node.textContent = answer;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    await fillTextField(node, answer);
  }

  async function fillApplicationFieldItems(fieldItems, answers, payload) {
    for (const item of fieldItems) {
      if (item.field.type === "file") continue;

      let answer = answers.get(item.field.fieldId) || "";
      if (isCoverLetterTextField(item) && payload.coverLetterText) {
        answer = payload.coverLetterText;
      }
      if (isCoverLetterTextField(item) && looksLikeFilename(answer)) {
        answer = payload.coverLetterText || "";
      }
      await fillControl(item, answer);
    }
  }

  async function ensureRequiredChoicesFilled(fieldItems, answers) {
    for (const item of fieldItems) {
      if (item.field.type === "file") continue;
      if (item.field.type === "checkbox") {
        if (isDemographicField(item.field)) continue;
        if (fieldLooksEmpty(item)) {
          await activateChoice(item.node, true);
          await sleep(80);
          if (fieldLooksEmpty(item)) {
            item.node.focus();
            item.node.click();
            nativeSetChecked(item.node, true);
          }
        }
        continue;
      }
      if (item.field.type === "radio") {
        const answer = answers.get(item.field.fieldId) || "";
        if (answer) await choose(item.node, answer, false);
        continue;
      }
      if (fieldLooksEmpty(item)) {
        const answer = answers.get(item.field.fieldId) || "";
        if (answer) await fillControl(item, answer);
      }
    }
  }

  function unresolvedFieldItems(fieldItems) {
    return fieldItems.filter((item) => item.field.type !== "file" && fieldLooksEmpty(item));
  }

  async function retryEmptyApplicationFields(fieldItems, payload, pageLanguage) {
    const emptyItems = unresolvedFieldItems(fieldItems);
    if (!emptyItems.length) return;

    const emptyFieldLines = emptyItems
      .map((i) => `"${i.field.label}" (type=${i.field.type}${i.field.required ? ", required" : ""}${i.field.options?.length ? `, options: ${i.field.options.slice(0, 6).join(" | ")}` : ""})`)
      .join("; ");
    const retryNote = `Still empty on page: ${emptyFieldLines}`;

    panel(["JobMate", `Retrying ${emptyItems.length} empty field(s)…`]);
    const retryPayload = await extensionMessage({
      type: "JOBMATE_FILL_ANSWERS",
      fields: emptyItems.map((item) => item.field),
      pageLanguage,
      retryNote
    }).catch((err) => ({ ok: false, error: err?.message ?? String(err) }));

    if (!retryPayload?.ok) {
      panel(["JobMate — retry failed", String(retryPayload?.error ?? "").slice(0, 300)]);
      return new Map();
    }

    const retryAnswers = new Map((retryPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));
    for (const item of emptyItems) {
      const answer = retryAnswers.get(item.field.fieldId) || "";
      if (answer) await fillControl(item, answer);
    }
    await checkNonDemographicCheckboxes(fieldItems);
    return retryAnswers;
  }

  function isNodeWithinContainer(node, container) {
    let current = node;
    while (current) {
      if (current === container) return true;
      if (current.parentElement) {
        current = current.parentElement;
      } else {
        const root = current.getRootNode();
        current = root instanceof ShadowRoot ? root.host : null;
      }
    }
    return false;
  }

  function sectionTitle(container) {
    const heading = headingInScope(container);
    if (heading) return heading;
    return clean(container.textContent || "").slice(0, 100);
  }

  function buttonActionText(node) {
    const shadowBtn = node.shadowRoot?.querySelector("button, a, [role='button']");
    if (shadowBtn) return actionText(shadowBtn) || actionText(node);
    return actionText(node);
  }

  function findButtonInContainer(container, wantedText) {
    const wanted = norm(wantedText);
    if (!wanted) return null;
    for (const btn of queryDeep("button, spl-button, oc-button, [role='button']", container)) {
      const text = norm(buttonActionText(btn));
      if (!text) continue;
      if (text === wanted || text.includes(wanted) || wanted.includes(text)) {
        return btn.shadowRoot?.querySelector("button, a, [role='button']") || btn;
      }
    }
    return null;
  }

  function findSectionContainer(section) {
    const target = norm(section.title || "");
    for (const root of fieldRoots()) {
      for (const container of queryDeep("section, fieldset, article, form, oc-experience, oc-education", root)) {
        const title = norm(sectionTitle(container));
        if (!title) continue;
        if (title === target || title.includes(target) || target.includes(title)) {
          return container;
        }
      }
    }
    return null;
  }

  function collectRepeatableSectionSnapshots() {
    const snapshots = [];
    const seen = new Set();
    for (const root of fieldRoots()) {
      for (const container of queryDeep("section, fieldset, article, form, oc-experience, oc-education", root)) {
        if (seen.has(container)) continue;
        seen.add(container);
        const buttons = [];
        const buttonSeen = new Set();
        for (const btn of queryDeep("button, spl-button, oc-button, [role='button']", container)) {
          if (!isActionRendered(btn)) continue;
          const text = buttonActionText(btn);
          if (!text || text.length > 40) continue;
          const key = norm(text);
          if (buttonSeen.has(key)) continue;
          buttonSeen.add(key);
          buttons.push({ text });
        }
        if (!buttons.length) continue;
        const title = sectionTitle(container);
        snapshots.push({
          sectionId: `sec_${snapshots.length}`,
          title,
          bodyText: clean(container.textContent || "").slice(0, 500),
          buttons
        });
      }
    }
    return snapshots;
  }

  function subformFieldItems(container) {
    return controls().filter((item) => isNodeWithinContainer(item.node, container));
  }

  async function fillRepeatableRecordSections(pageLanguage) {
    const snapshots = collectRepeatableSectionSnapshots();
    if (!snapshots.length) return;

    const detect = await extensionMessage({
      type: "JOBMATE_DETECT_REPEATABLE_SECTIONS",
      sections: snapshots,
      pageLanguage
    }).catch(() => null);
    if (!detect?.ok || !detect.sections?.length) return;

    const extract = await extensionMessage({
      type: "JOBMATE_EXTRACT_RECORDS",
      pageLanguage
    }).catch(() => null);
    if (!extract?.ok) return;

    const recordsByType = {
      experience: Array.isArray(extract.experience) ? extract.experience : [],
      education: Array.isArray(extract.education) ? extract.education : []
    };

    for (const section of detect.sections) {
      if (section.recordType === "other") continue;
      const entries = recordsByType[section.recordType];
      if (!entries?.length) continue;

      const snapshot = snapshots.find((item) => item.sectionId === section.sectionId);
      const container = findSectionContainer(snapshot ? { ...section, title: snapshot.title } : section);
      if (!container) continue;

      for (const record of entries) {
        const addBtn = findButtonInContainer(container, section.addButtonText);
        if (!addBtn) continue;
        await aggressiveClick(addBtn);
        await sleep(700);

        const subFields = subformFieldItems(container).filter((item) => item.field.type !== "file");
        if (!subFields.length) continue;

        const actionButtons = [];
        const actionSeen = new Set();
        for (const btn of queryDeep("button, spl-button, oc-button, [role='button']", container)) {
          const text = buttonActionText(btn);
          const key = norm(text);
          if (!text || actionSeen.has(key)) continue;
          actionSeen.add(key);
          actionButtons.push(text);
        }

        const mapResult = await extensionMessage({
          type: "JOBMATE_MAP_RECORD_FIELDS",
          recordType: section.recordType,
          record,
          fields: subFields.map((item) => item.field),
          actionButtons,
          pageLanguage
        }).catch(() => null);
        if (!mapResult?.ok) continue;

        const recordAnswers = new Map((mapResult.answers || []).map((item) => [item.fieldId, item.answer || ""]));
        for (const item of subFields) {
          const answer = recordAnswers.get(item.field.fieldId) || "";
          await fillControl(item, answer);
        }
        await sleep(250);

        const saveBtn = findButtonInContainer(container, mapResult.saveButtonText);
        if (saveBtn) {
          await aggressiveClick(saveBtn);
          await sleep(900);
        }
      }
    }
  }

  async function fillApplicationForm(payload) {
    let fieldItems = syncFileFieldItems(controls());

    panel(["JobMate", "Generating answers…"]);
    const answersPayload = await extensionMessage({
      type: "JOBMATE_FILL_ANSWERS",
      fields: fieldItems.map((item) => item.field),
      pageLanguage: detectPageLanguage()
    });
    if (!answersPayload?.ok) {
      const reason = answersPayload?.error;
      throw new Error(reason || `Gemini call for JOBMATE_FILL_ANSWERS returned ok=false with no error message — raw response: ${JSON.stringify(answersPayload)}`);
    }

    const fileIds = resolveFileAttachmentIds(
      fieldItems,
      answersPayload.resumeFieldIds || [],
      answersPayload.coverLetterFieldIds || []
    );
    const resumeFieldIds = fileIds.resumeFieldIds;
    let coverLetterFileIds = fileIds.coverLetterFieldIds;
    payload.coverLetterText = answersPayload.coverLetterText || payload.coverLetterText || "";

    const answers = new Map((answersPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));
    lastFormFill = { fieldItems: fieldItems.slice(), answers, url: location.href };

    for (const item of fieldItems) {
      const current = answers.get(item.field.fieldId) || "";
      const optOut = optOutAnswer(item.field);
      if (optOut && (!current || !item.field.options.some((opt) => norm(opt) === norm(current)))) {
        answers.set(item.field.fieldId, optOut);
      }
    }

    panel(["JobMate", "Filling form…"]);
    await attachResumeOnce(fieldItems, payload, resumeFieldIds, coverLetterFileIds);
    await fillApplicationFieldItems(fieldItems, answers, payload);
    await ensureRequiredChoicesFilled(fieldItems, answers);
    await fillRepeatableRecordSections(detectPageLanguage());

    const emptyRequired = fieldItems.filter(
      (item) => item.field.type !== "file" && item.field.required && fieldLooksEmpty(item)
    );
    if (emptyRequired.length) {
      const refusal = await extensionMessage({
        type: "JOBMATE_EXPLAIN_REFUSAL",
        fields: emptyRequired.map((item) => item.field),
        answers: emptyRequired.map((item) => ({ fieldId: item.field.fieldId, answer: answers.get(item.field.fieldId) || "" }))
      }).catch(() => null);
      if (refusal?.ok && refusal.lines?.length) {
        panel(["JobMate — Gemini left required fields blank", ...refusal.lines.slice(0, 8)]);
        await sleep(3000);
      }
    }

    const needsCoverLetterReview =
      coverLetterFileIds.length > 0 || hasCoverLetterTextField(fieldItems);

    if (needsCoverLetterReview) {
      panel(["JobMate", "Review cover letter in the other tab, then Save or Reject."]);
      const review = await extensionMessage({
        type: "JOBMATE_COVER_LETTER_REVIEW",
        draft: payload.coverLetterText || "",
        pageLanguage: detectPageLanguage()
      });
      if (review?.action === "reject") {
        coverLetterFileIds = [];
        payload.coverLetterText = "";
      } else if (review?.action === "save") {
        payload.coverLetterText = String(review.text || "").trim();
        if (payload.coverLetterText) {
          for (const item of fieldItems) {
            if (isCoverLetterTextField(item)) {
              await fillControl(item, payload.coverLetterText);
            }
          }
        } else {
          coverLetterFileIds = [];
        }
      } else {
        coverLetterFileIds = [];
      }
    }

    fieldItems = syncFileFieldItems(fieldItems);
    if (coverLetterFileIds.length > 0 && payload.coverLetterText) {
      await attachCoverLetterFiles(fieldItems, payload, coverLetterFileIds, resumeFieldIds);
    }
  }

  async function fillAuthForm(payload, fieldItems, elements) {
    const password = await getSitePassword();
    const answersPayload = await extensionMessage({
      type: "JOBMATE_FILL_ANSWERS",
      fields: fieldItems.map((item) => item.field),
      pageLanguage: detectPageLanguage()
    });
    if (!answersPayload?.ok) {
      throw new Error(answersPayload?.error || "Could not generate auth form answers.");
    }
    const answers = new Map((answersPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));

    for (const item of fieldItems) {
      let answer = answers.get(item.field.fieldId) || "";
      if (item.field.type === "password") answer = password;
      if (answer) await fillControl(item, answer);
    }

    const passwordField = fieldItems.find((item) => item.field.type === "password");
    await sleep(150);
    submitViaEnter(passwordField?.node || fieldItems[fieldItems.length - 1]?.node);
  }

  function showActionPanel(options) {
    const { id, statusLines, btnLabel, btnColor, onConfirm, alertTitle, hasInput, inputPlaceholder } = options;

    panel(statusLines);

    if (alertTitle) {
      const prev = document.title;
      document.title = `⚠ ${alertTitle} — ${prev}`;
      const restoreTitle = () => { document.title = prev; };
      setTimeout(restoreTitle, 30000);
    }

    return new Promise((resolve) => {
      const existing = id ? document.getElementById(id) : null;
      if (existing) existing.remove();

      const wrap = document.createElement("div");
      if (id) wrap.id = id;
      wrap.style.cssText = "position:fixed;right:16px;bottom:90px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-width:360px";

      const btn = document.createElement("button");
      btn.textContent = btnLabel;
      btn.style.cssText = `background:${btnColor || "#059669"};color:white;border:none;padding:10px 16px;border-radius:6px;font:14px -apple-system,sans-serif;cursor:pointer;width:100%`;
      let instructionInput = null;
      if (hasInput) {
        instructionInput = document.createElement("textarea");
        instructionInput.placeholder = inputPlaceholder || "Optional instruction for JobMate";
        instructionInput.style.cssText =
          "box-sizing:border-box;width:100%;min-height:90px;padding:10px 12px;border-radius:6px;border:1px solid #4b5563;background:#111827;color:#f9fafb;font:13px -apple-system,sans-serif;resize:vertical";
        wrap.appendChild(instructionInput);
      }
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Working…";
        const userInstruction = instructionInput ? instructionInput.value.trim() : "";
        await onConfirm?.(userInstruction);
        wrap.remove();
        resolve(userInstruction);
      };

      wrap.appendChild(btn);
      document.body.appendChild(wrap);
    });
  }

  function showConfirmPanel() {
    extensionMessage({
      type: "JOBMATE_APPLY_NEEDS_ATTENTION",
      message: "Application form filled — please review.",
      instruction: "Review the answers in this tab, then click Confirm.",
      applyUrl: location.href,
      kind: "confirm"
    }).catch(() => { });

    panel(["JobMate: application form filled", "Review the form, then confirm below."]);

    return new Promise((resolve) => {
      const existing = document.getElementById("jobmate-confirm-wrap");
      if (existing) existing.remove();

      const wrap = document.createElement("div");
      wrap.id = "jobmate-confirm-wrap";
      wrap.style.cssText = "position:fixed;right:16px;bottom:90px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;max-width:360px;pointer-events:auto";

      const fixBox = document.createElement("div");
      fixBox.style.cssText = "background:#1f2937;color:#f9fafb;padding:10px 12px;border-radius:6px;font:13px/1.4 -apple-system,sans-serif;display:flex;flex-direction:column;gap:6px";

      const fixHint = document.createElement("div");
      fixHint.style.cssText = "font-size:11px;color:#9ca3af";
      fixHint.textContent = "Click any field on this form to select it for correction";
      fixBox.appendChild(fixHint);

      const fixInput = document.createElement("input");
      fixInput.type = "text";
      fixInput.placeholder = "Describe the correction…";
      fixInput.style.cssText = "width:100%;box-sizing:border-box;background:#374151;color:#f9fafb;border:1px solid #4b5563;border-radius:4px;padding:6px 8px;font:13px -apple-system,sans-serif;outline:none";
      fixBox.appendChild(fixInput);

      const fixBtn = document.createElement("button");
      fixBtn.textContent = "Fix field";
      fixBtn.disabled = true;
      fixBtn.style.cssText = "background:#4b5563;color:white;border:none;padding:6px 12px;border-radius:4px;font:13px -apple-system,sans-serif;cursor:pointer;align-self:flex-end";
      fixBox.appendChild(fixBtn);

      wrap.appendChild(fixBox);

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Confirm — looks good";
      confirmBtn.style.cssText = "background:#059669;color:white;border:none;padding:10px 16px;border-radius:6px;font:14px -apple-system,sans-serif;cursor:pointer;width:100%";
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Working…";
        cleanupPickMode();
        await extensionMessage({ type: "JOBMATE_SESSION_COMPLETE", applicationUrl: location.href }).catch(() => { });
        wrap.remove();
        panel(["JobMate: confirmed ✓", "Submit the application when ready."]);
        resolve();
      };
      wrap.appendChild(confirmBtn);

      document.body.appendChild(wrap);

      let selectedItem = null;
      let highlightedNode = null;
      let originalOutline = "";

      function cleanupPickMode() {
        if (highlightedNode) {
          highlightedNode.style.outline = originalOutline;
          highlightedNode = null;
        }
        document.removeEventListener("click", onFormFieldClick, true);
      }

      function onFormFieldClick(ev) {
        if (wrap.contains(ev.target)) return;
        let node = ev.target;
        while (node && node !== document.body) {
          if (node.dataset && node.dataset.jobmateFieldId) {
            ev.stopPropagation();
            ev.preventDefault();
            const fieldId = node.dataset.jobmateFieldId;
            const items = controls();
            const item = items.find((i) => i.field.fieldId === fieldId);
            if (item) {
              if (highlightedNode && highlightedNode !== node) {
                highlightedNode.style.outline = originalOutline;
              }
              selectedItem = item;
              highlightedNode = node;
              originalOutline = node.style.outline;
              node.style.outline = "2px solid #059669";
              fixHint.textContent = `Selected: "${item.field.label || fieldId}"`;
              fixBtn.disabled = false;
            }
            return;
          }
          node = node.parentElement;
        }
      }

      document.addEventListener("click", onFormFieldClick, true);

      fixBtn.onclick = async () => {
        const note = fixInput.value.trim();
        if (!selectedItem || !note) return;
        fixBtn.disabled = true;
        fixBtn.textContent = "Fixing…";

        const data = await extensionMessage({
          type: "JOBMATE_FILL_ANSWERS",
          fields: [selectedItem.field],
          retryNote: `User correction for field "${selectedItem.field.label}": ${note}`
        }).catch(() => null);

        if (data?.ok) {
          const answer = (data.answers || []).find((a) => a.fieldId === selectedItem.field.fieldId)?.answer || "";
          if (answer) {
            await fillControl(selectedItem, answer);
          }
        }

        if (highlightedNode) {
          highlightedNode.style.outline = originalOutline;
          highlightedNode = null;
        }
        selectedItem = null;
        fixInput.value = "";
        fixHint.textContent = "Click any field on this form to select it for correction";
        fixBtn.textContent = "Fix field";
        fixBtn.disabled = true;
      };
    });
  }

  function pageStateKey(fieldCount) {
    return normalizeHref(location.href) + "|f" + fieldCount;
  }

  async function rememberPlaybookStep(pageUrl, fieldCount, action, elements) {
    const pageText = clean(document.body?.textContent || "").slice(0, 800);
    if (action.tool === "navigate" && action.url) {
      await recordPlaybookStep(pageUrl, fieldCount, "navigate", null, action.url, pageText);
      return;
    }
    if (action.tool !== "click" && action.tool !== "submit") return;
    const elemEntry =
      elements.find((e) => e.elementId === action.elementId) ||
      cachedInteractiveActions.find((e) => e.elementId === action.elementId);
    if (!elemEntry) return;
    await recordPlaybookStep(pageUrl, fieldCount, action.tool, elemEntry, null, pageText);
  }

  async function rememberPlaybookIfAdvanced(stateBefore, pageUrl, fieldCount, action, elements) {
    await sleep(400);
    const { fieldItems: fieldsAfter } = collectPageElements(null);
    if (pageStateKey(fieldsAfter.length) === stateBefore) return;
    await rememberPlaybookStep(pageUrl, fieldCount, action, elements);
  }

  async function requestHumanHelp(whatHappened, instruction) {
    await extensionMessage({
      type: "JOBMATE_APPLY_NEEDS_ATTENTION",
      message: whatHappened,
      instruction,
      applyUrl: location.href
    }).catch(() => { });

    const result = await showActionPanel({
      id: "jobmate-help-wrap",
      statusLines: ["⚠ JobMate needs your help", whatHappened, instruction],
      btnLabel: "Continue",
      btnColor: "#b45309",
      alertTitle: "Needs attention",
      hasInput: true,
      inputPlaceholder: "Optional instruction for JobMate before continuing",
      onConfirm: async (userInstruction) => {
        if (userInstruction) {
          await extensionMessage({
            type: "JOBMATE_APPLY_HUMAN_INSTRUCTION",
            instruction: userInstruction,
            applyUrl: location.href
          }).catch(() => { });
        }
      }
    });
    resetUrlPingPongTrack();
    await extensionMessage({ type: "JOBMATE_RESET_URL_OSCILLATION" }).catch(() => { });
    return typeof result === "string" ? result : "";
  }

  function panel(lines) {
    let box = document.getElementById("jobmate-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "jobmate-status";
      box.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111827;color:white;padding:12px 14px;border-radius:8px;max-width:400px;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:8px";

      const textEl = document.createElement("div");
      textEl.className = "jobmate-status-text";
      textEl.style.whiteSpace = "pre-wrap";
      box.appendChild(textEl);

      const interruptBtn = document.createElement("button");
      interruptBtn.type = "button";
      interruptBtn.textContent = "Interrupt";
      interruptBtn.style.cssText =
        "background:transparent;color:#fcd34d;border:1px solid #b45309;padding:8px 12px;border-radius:6px;font:13px -apple-system,sans-serif;cursor:pointer;width:100%";
      interruptBtn.onclick = () => {
        forcedInterrupt = {
          reason: "Interrupted by user.",
          instruction: "Complete the action needed to unblock this application, then click Continue."
        };
      };
      box.appendChild(interruptBtn);

      document.body.appendChild(box);
    }
    const textEl = box.querySelector(".jobmate-status-text");
    const text = Array.isArray(lines) ? lines.filter(Boolean).join("\n") : String(lines ?? "");
    if (textEl) {
      textEl.textContent = text;
    }
  }

  function fetchViaExtension(url, init = {}, attempt = 0) {
    return new Promise((resolve, reject) => {
      const headers =
        init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : { ...(init.headers || {}) };

      chrome.runtime.sendMessage(
        { type: "jobmate_fetch", url, method: init.method || "GET", headers, body: init.body },
        (response) => {
          const last = chrome.runtime.lastError;
          if (last) {
            const msg = last.message || "";
            const retry =
              attempt < 5 &&
              /Receiving end does not exist|The message port closed before a response was received|Could not establish connection/i.test(msg);
            if (retry) {
              setTimeout(() => fetchViaExtension(url, init, attempt + 1).then(resolve).catch(reject), 80 * (attempt + 1));
              return;
            }
            reject(new Error(msg || "Extension messaging failed"));
            return;
          }
          if (!response) { reject(new Error("Empty extension response")); return; }
          if (response.error) { reject(new Error(response.error)); return; }
          resolve(response);
        }
      );
    });
  }

  async function jobmateFetch(url, init = {}) {
    if (typeof chrome !== "undefined" && chrome.runtime?.id) {
      const ext = await fetchViaExtension(url, init);
      return { ok: ext.ok, status: ext.status, json: async () => JSON.parse(ext.text) };
    }
    return fetch(url, init);
  }

  function isRegistrationGatePage(elements) {
    const fields = elements.filter((e) => e.type === "field");
    if (fields.some((f) => f.fieldType === "file" || f.fieldType === "textarea" || f.fieldType === "contenteditable")) {
      return false;
    }
    if (fields.length >= 8) return false;
    return fields.some((f) => f.fieldType === "password");
  }

  function authGateReadyToFill(fieldItems) {
    return fieldItems.some((item) => item.field.type === "password");
  }

  function isApplicationFormPage(elements) {
    const fields = elements.filter((e) => e.type === "field");
    if (!fields.length) return false;
    if (isRegistrationGatePage(elements)) return false;
    const hasPassword = fields.some((f) => f.fieldType === "password");
    if (hasPassword) return false;
    return true;
  }

  function isAuthFormPage(elements) {
    return isRegistrationGatePage(elements);
  }

  function statusPanel(step, maxSteps, action, extra) {
    const tag = action.elementId ? `[${action.elementId}]` : action.url ? `→ ${action.url.slice(0, 60)}` : "";
    panel([
      `JobMate · step ${step + 1}/${maxSteps} · ${action.tool} ${tag}`,
      action.reasoning ? action.reasoning.slice(0, 200) : "",
      extra || ""
    ]);
  }

  const urlPingPongTrack = { a: null, b: null, last: null, switches: 0 };

  function resetUrlPingPongTrack() {
    urlPingPongTrack.a = null;
    urlPingPongTrack.b = null;
    urlPingPongTrack.last = null;
    urlPingPongTrack.switches = 0;
  }

  function recordUrlPingPong(href) {
    const u = normalizeHref(href);
    if (!u) return false;
    if (u === urlPingPongTrack.last) return urlPingPongTrack.switches >= 6;
    if (!urlPingPongTrack.a) {
      urlPingPongTrack.a = u;
      urlPingPongTrack.last = u;
      return false;
    }
    if (!urlPingPongTrack.b && u !== urlPingPongTrack.a) {
      urlPingPongTrack.b = u;
      urlPingPongTrack.last = u;
      urlPingPongTrack.switches = 1;
      return false;
    }
    if (u === urlPingPongTrack.a || u === urlPingPongTrack.b) {
      urlPingPongTrack.switches += 1;
      urlPingPongTrack.last = u;
      return urlPingPongTrack.switches >= 6;
    }
    return false;
  }

  async function recoverFromUrlPingPong(step, history, hiddenApplyUrl, blockedElementIds, payloadUrl) {
    panel(["JobMate", "Finding apply button…", "Clicking through to the application form."]);
    resetUrlPingPongTrack();
    await extensionMessage({ type: "JOBMATE_RESET_URL_OSCILLATION" }).catch(() => { });

    const rescan = await forcePageRescan(hiddenApplyUrl);
    const action = await callStep(step, history, hiddenApplyUrl, rescan.elements, blockedElementIds);

    if (action.tool === "click" && action.elementId) {
      const ok = await activateElement(payloadUrl, action.elementId, rescan.elements, {
        step,
        maxSteps: MAX_STEPS,
        action
      });
      if (ok) {
        history.push({
          step,
          tool: "click",
          reasoning: action.reasoning || "apply navigation after url oscillation",
          elementId: action.elementId
        });
        await sleep(600);
        return true;
      }
    }

    if (action.tool === "navigate" && action.url && navigateNow(action.url, hiddenApplyUrl)) {
      history.push({
        step,
        tool: "navigate",
        reasoning: action.reasoning || "apply navigation after url oscillation",
        url: action.url
      });
      return true;
    }

    return false;
  }

  async function stopUrlPingPong(step, history, hiddenApplyUrl, blockedElementIds, payloadUrl) {
    const recovered = await recoverFromUrlPingPong(step, history, hiddenApplyUrl, blockedElementIds, payloadUrl);
    if (recovered) {
      return;
    }
    await requestHumanHelp(
      "Stopped: the browser kept switching between the same two URLs.",
      "Complete what's needed on this page, then click Continue."
    );
  }

  async function run() {
    const payloadUrl = await resolvePayloadUrl();
    if (!payloadUrl) return;
    await runWithPayloadUrl(payloadUrl);
  }

  async function runWithPayloadUrl(payloadUrl) {
    if (!(await verifyRunner(payloadUrl))) {
      return;
    }

    panel("JobMate: loading payload…");
    const payloadResp = await extensionMessage({ type: "JOBMATE_GET_PAYLOAD" });
    if (!payloadResp?.ok) throw new Error(payloadResp?.error || "Could not load payload.");
    const payload = payloadResp.payload;
    applySessionTargetUrl = payload.applyUrl || location.href;

    panel("JobMate: waiting for page to load…");
    await waitForPageLoad();

    const history = [];
    const handledForms = new Set();
    const failuresByState = new Map();
    const blockedElementIds = new Set();
    const failedTaskAttempts = new Map();
    const MAX_STEPS = 20;
    const STUCK_THRESHOLD = 3;
    let lastReason = "";
    let lastFormFill = null;

    async function checkStuck(step, stateBefore, instruction, taskKey, hiddenApplyUrl) {
      await sleep(400);
      const { fieldItems: fieldsAfter } = collectPageElements(null);
      const stateAfter = pageStateKey(fieldsAfter.length);
      if (stateAfter !== stateBefore) {
        failuresByState.delete(stateBefore);
        return;
      }
      const attempts = (failuresByState.get(stateBefore) || 0) + 1;
      failuresByState.set(stateBefore, attempts);
      const stuckTaskKey = taskKey || `state:${stateBefore}`;
      const totalFailures = (failedTaskAttempts.get(stuckTaskKey) || 0) + 1;
      failedTaskAttempts.set(stuckTaskKey, totalFailures);
      if (totalFailures >= STUCK_THRESHOLD || attempts >= STUCK_THRESHOLD) {
        const rescan = await forcePageRescan(hiddenApplyUrl);
        if (rescan.fieldItems.length > 0) {
          failuresByState.set(stateBefore, 0);
          failedTaskAttempts.set(stuckTaskKey, 0);
          return;
        }
        const probe = await callStep(step, history, hiddenApplyUrl, rescan.elements, blockedElementIds);
        if (probe.tool !== "wait" && probe.tool !== "blocked") {
          failuresByState.set(stateBefore, 0);
          failedTaskAttempts.set(stuckTaskKey, 0);
          return;
        }
        failuresByState.set(stateBefore, 0);
        failedTaskAttempts.set(stuckTaskKey, 0);
        const userInstruction = await requestHumanHelp(
          lastReason || "The agent is stuck on this step.",
          instruction || "Complete what's needed on this page, then click Continue."
        );
        history.push({ step: history.length, tool: "human_unblocked", reasoning: "user resolved stuck state" });
        if (userInstruction) {
          history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
        }
      }
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      if (!(await verifyRunner(payloadUrl))) {
        return;
      }

      if (forcedInterrupt) {
        const pending = forcedInterrupt;
        forcedInterrupt = null;
        const userInstruction = await requestHumanHelp(
          pending.reason || "Interrupted by user.",
          pending.instruction || "Complete what's needed on this page, then click Continue."
        );
        history.push({ step: history.length, tool: "human_interrupt", reasoning: pending.reason || "Interrupted by user." });
        if (userInstruction) {
          history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
        }
        continue;
      }

      await waitForPageLoad();

      let hiddenApplyUrl = extractHiddenApplyUrl();

      if (
        applySessionTargetUrl &&
        normalizeHref(location.href) !== normalizeHref(applySessionTargetUrl)
      ) {
        hasLeftTargetListing = true;
      }

      let { elements, fieldItems } = collectPageElements(hiddenApplyUrl);
      if (!fieldItems.length) {
        const dialogSelector = '[role="dialog"], [role="alertdialog"], dialog, .modal, [class*="modal"], [class*="dialog"], [aria-modal="true"]';
        const hasOpenDialog = !!document.querySelector(dialogSelector);
        if (hasOpenDialog) {
          for (let w = 0; w < 8; w++) {
            await sleep(300);
            const check = collectPageElements(hiddenApplyUrl);
            if (check.fieldItems.length) {
              elements = check.elements;
              fieldItems = check.fieldItems;
              break;
            }
          }
        }
      }

      const rescanned = collectPageElements(hiddenApplyUrl);
      if (rescanned.elements.length > elements.length) {
        elements = rescanned.elements;
        fieldItems = rescanned.fieldItems;
      }

      if (recordUrlPingPong(location.href)) {
        await stopUrlPingPong(step, history, hiddenApplyUrl, blockedElementIds, payloadUrl);
        continue;
      }

      const stateBefore = pageStateKey(fieldItems.length);
      const formKey = stateBefore;

      if (fieldItems.length > 0 && !handledForms.has(formKey)) {
        if (isApplicationFormPage(elements)) {
          if (!(await verifyRunner(payloadUrl))) {
            return;
          }
          handledForms.add(formKey);
          failuresByState.delete(stateBefore);
          resetUrlPingPongTrack();
          await extensionMessage({ type: "JOBMATE_RESET_URL_OSCILLATION" }).catch(() => { });
          await fillApplicationForm(payload);
          history.push({ step, tool: "form_fill", reasoning: `filled ${fieldItems.length} fields` });
          continue;
        }

        if (isAuthFormPage(elements)) {
          if (authGateReadyToFill(fieldItems) && !handledForms.has(formKey)) {
            panel(["JobMate", "Login/register form", "Filling and submitting…"]);
            await fillAuthForm(payload, fieldItems, elements);
            history.push({ step, tool: "auth_fill", reasoning: "filled and submitted auth form" });
            const { fieldItems: fieldsAfter } = collectPageElements(null);
            const stateAfter = pageStateKey(fieldsAfter.length);
            if (stateAfter !== stateBefore) {
              handledForms.add(formKey);
              failuresByState.delete(stateBefore);
            } else {
              await checkStuck(
                step,
                stateBefore,
                "Please submit the login/registration form manually, then click Continue.",
                `auth_submit|${stateBefore}`,
                hiddenApplyUrl
              );
            }
            continue;
          }
        }
      }

      const pageUrlBefore = location.href;
      const fieldCountBefore = fieldItems.length;
      panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Analyzing page…"]);
      let action = await callStep(step, history, hiddenApplyUrl, elements, blockedElementIds);
      if (action.fromSemanticMemory || action.fromPlaybook) {
        panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Known path…"]);
      } else if (action.tool !== "wait") {
        statusPanel(step, MAX_STEPS, action);
      }

      if (action.tool === "wait") {
        const upgraded = await tryUpgradeWaitAction(step, history, hiddenApplyUrl, blockedElementIds);
        if (upgraded.rescanFields) {
          failuresByState.delete(stateBefore);
          failedTaskAttempts.delete(`wait|${stateBefore}`);
          continue;
        }
        if (upgraded.action) {
          action = upgraded.action;
        }
      }

      const histEntry = {
        step,
        tool: action.tool,
        reasoning: action.reasoning,
        elementId: action.elementId ?? null,
        url: action.url ?? null
      };
      lastReason = action.reasoning || "";

      if (action.tool === "blocked") {
        const userInstruction = await requestHumanHelp(
          action.reasoning || "The agent is blocked.",
          "Complete what's needed on this page, then click Continue."
        );
        history.push({ ...histEntry, tool: "human_unblocked" });
        if (userInstruction) {
          history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
        }
        failuresByState.delete(stateBefore);
        continue;
      }

      if (action.tool === "wait") {
        statusPanel(step, MAX_STEPS, action, "Waiting for page…");
        history.push(histEntry);
        await checkStuck(step, stateBefore, "Complete what's needed on this page, then click Continue.", `wait|${stateBefore}`, hiddenApplyUrl);
        continue;
      }

      if (action.tool === "navigate" && action.url) {
        if (
          (applySessionTargetUrl && isOffTargetJobUrl(action.url, getApplyAnchors(hiddenApplyUrl), location.href)) ||
          (hasLeftTargetListing && applySessionTargetUrl && isReturnToListingUrl(action.url, applySessionTargetUrl, location.href))
        ) {
          blockedElementIds.add(action.elementId || `nav:${action.url}`);
          const userInstruction = await requestHumanHelp(
            "Blocked forbidden navigation.",
            "Complete what's needed on this page, then click Continue."
          );
          if (userInstruction) {
            history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
          }
          continue;
        }
        statusPanel(step, MAX_STEPS, action);
        if (navigateNow(action.url, hiddenApplyUrl)) {
          await rememberPlaybookStep(pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
          return;
        }
        blockedElementIds.add(`nav:${action.url}`);
        history.push({ ...histEntry, reasoning: "navigation did not change page" });
        await checkStuck(
          step,
          stateBefore,
          "Complete what's needed on this page, then click Continue.",
          `navigate|${action.url || stateBefore}`,
          hiddenApplyUrl
        );
        continue;
      }

      if (action.tool === "select" && action.elementId && action.value) {
        const node = nodeByElementId(action.elementId);
        const fieldItem = fieldItems.find((item) => item.node === node) || {
          node,
          field: { type: "select", label: node ? nearbyLabel(node) : "" }
        };
        if (node) {
          statusPanel(step, MAX_STEPS, action);
          await fillDropdownField(fieldItem, action.value);
          history.push(histEntry);
          continue;
        }
      }

      if (action.tool === "type" && action.elementId && action.value) {
        const node = nodeByElementId(action.elementId);
        if (node) {
          statusPanel(step, MAX_STEPS, action);
          await fillTextField(node, action.value);
          history.push(histEntry);
          continue;
        }
      }

      if (action.tool === "submit" && action.elementId) {
        await showConfirmPanel();
        const ok = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
        if (ok === "navigated") return;
        history.push(histEntry);
        if (!ok) blockedElementIds.add(action.elementId);
        return;
      }

      if (action.tool === "click" && (action.elementId || action.coords)) {
        const ok = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
        if (ok === "navigated") {
          await rememberPlaybookStep(pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
          lastFormFill = null;
          return;
        }
        history.push(histEntry);

        await sleep(600);
        const { fieldItems: fieldsAfterClick, elements: elementsAfterClick } = collectPageElements(null);
        const stateAfterClick = pageStateKey(fieldsAfterClick.length);
        const pageStuck = stateAfterClick === stateBefore;
        const urlChanged = normalizeHref(location.href) !== normalizeHref(pageUrlBefore);
        const advanced = !pageStuck || urlChanged || isApplicationFormPage(elementsAfterClick);

        if (ok && advanced) {
          failuresByState.delete(stateBefore);
          resetUrlPingPongTrack();
          await extensionMessage({ type: "JOBMATE_RESET_URL_OSCILLATION" }).catch(() => { });
          await rememberPlaybookIfAdvanced(stateBefore, pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
        } else if (action.coords) {
          blockedElementIds.add(`coord:${action.coords.x},${action.coords.y}`);
        } else if (action.elementId) {
          blockedElementIds.add(action.elementId);
        }

        if (ok && action.value) {
          await sleep(300);
          if (!(await findAndClickOption(action.value))) {
            await clickDropdownOptionViaOcr(action.value, action.reasoning || "");
          }
        }

        if (pageStuck && lastFormFill && lastFormFill.url === pageUrlBefore) {
          const fill = lastFormFill;
          lastFormFill = null;

          const validationErrors = collectValidationErrors();
          const fieldStates = fill.fieldItems
            .filter((item) => item.field.type !== "file")
            .map((item) => ({
              fieldId: item.field.fieldId,
              label: item.field.label,
              type: item.field.type,
              required: item.field.required,
              options: item.field.options,
              value: fieldValueForValidation(item)
            }));

          panel(["JobMate", "Validating form step…"]);

          const validateResult = await extensionMessage({
            type: "JOBMATE_VALIDATE_ADVANCE",
            goal: "Advance past the current application form step after clicking Continue or Next",
            pageUrl: location.href,
            validationErrors,
            fields: fieldStates
          }).catch(() => null);

          if (validateResult?.ok && validateResult.advanced) {
            failuresByState.delete(stateBefore);
            continue;
          }

          const placementReport = fill.fieldItems
            .filter((item) => item.field.type !== "file")
            .map((item) => ({
              fieldId: item.field.fieldId,
              label: item.field.label,
              type: item.field.type,
              required: item.field.required,
              options: item.field.options,
              answer: fill.answers.get(item.field.fieldId) || ""
            }));

          const explainResult = await extensionMessage({
            type: "JOBMATE_EXPLAIN_PLACEMENTS",
            placements: placementReport,
            validationErrors
          }).catch(() => null);

          if (explainResult?.ok && Array.isArray(explainResult.explanations)) {
            const lines = explainResult.explanations.map((e) =>
              `Field: "${e.label}" (${e.type})\nPlaced: ${JSON.stringify(e.answer)}\nReason: ${e.reasoning}`
            );
            panel(["JobMate — form audit", ...lines.slice(0, 6)]);
            await sleep(1200);
          }
        }

        await checkStuck(
          step,
          stateBefore,
          "Complete what's needed on this page, then click Continue.",
          `click|${action.elementId || stateBefore}`,
          hiddenApplyUrl
        );
        continue;
      }

      history.push(histEntry);
      await checkStuck(step, stateBefore, "Complete what's needed on this page, then click Continue.", `${action.tool}|${stateBefore}`, hiddenApplyUrl);
    }

    panel(["JobMate: step limit reached", "Could not reach application form."]);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "JOBMATE_FORCE_INTERRUPT") {
      forcedInterrupt = {
        reason: typeof msg.reason === "string" ? msg.reason : "Interrupted by user.",
        instruction:
          typeof msg.instruction === "string"
            ? msg.instruction
            : "Complete what's needed on this page, then click Continue."
      };
      sendResponse({ ok: true });
      return true;
    }
    if (msg?.type === "JOBMATE_START_APPLY") {
      run().catch((err) => {
        const m = err?.message ?? String(err);
        panel(["JobMate error", m.slice(0, 400)]);
      });
      sendResponse({ ok: true });
      return true;
    }
    return;
  });

  run().catch((err) => {
    const m = err?.message ?? String(err);
    panel(["JobMate error", m.slice(0, 400)]);
  });
})();
