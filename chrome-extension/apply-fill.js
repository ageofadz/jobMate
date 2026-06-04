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
  let elemSeq = 0;

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

  function navigateNow(href) {
    if (!href || normalizeHref(href) === normalizeHref(location.href)) {
      return false;
    }
    if (isForbiddenNavigationUrl(href, location.href)) {
      return false;
    }
    location.assign(href);
    return true;
  }

  async function activateElement(payloadUrl, elementId, elements, actionMeta) {
    const node = nodeByElementId(elementId);
    if (!node) return false;

    const elemEntry = elements.find((e) => e.elementId === elementId);
    const elemHref = elemEntry?.href || resolveHref(node) || "";
    const elemText = elemEntry?.text || clean(node.textContent || "");
    if (elemHref && isForbiddenNavigationUrl(elemHref, location.href)) {
      return false;
    }
    statusPanel(actionMeta.step, actionMeta.maxSteps, {
      ...actionMeta.action,
      elementId: `${elementId} "${elemText.slice(0, 40)}"`
    });

    const href = resolveHref(node) || elemEntry?.href || null;
    if (href) {
      if (node.tagName === "A") node.setAttribute("target", "_self");
      if (navigateNow(href)) return "navigated";
    }

    if (isSubmitLike(node, actionMeta.action)) {
      submitViaEnter(node);
      await sleep(300);
    }

    if (opensFileChooser(node)) {
      return false;
    }

    await aggressiveClick(node);
    return true;
  }

  function nodeByElementId(elementId) {
    return elementRegistry.get(elementId) || null;
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

  function isLikelyPointerClickable(node) {
    if (node.closest('button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"]')) {
      return false;
    }
    const tag = node.tagName;
    if (!["DIV", "SPAN", "LI", "P", "LABEL", "TD", "TH"].includes(tag)) return false;
    if (!isActionRendered(node)) return false;
    const style = window.getComputedStyle(node);
    if (style.cursor !== "pointer") return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.width > 480 || rect.height > 120) return false;
    const text = actionText(node);
    return Boolean(text);
  }

  function collectActionCandidates() {
    const selector =
      'button, a, [role="button"], [role="tab"], [role="link"], input[type="button"], input[type="submit"], [onclick], label[for]';
    const seen = new Set();
    const nodes = [];

    for (const root of fieldRoots()) {
      for (const node of queryDeep(selector, root)) {
        if (seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }

    for (const root of fieldRoots()) {
      for (const node of queryDeep("div, span, li, p, label, td, th", root)) {
        if (seen.has(node)) continue;
        if (!isLikelyPointerClickable(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }

    return nodes.filter((node) => !nodes.some((other) => other !== node && node.contains(other)));
  }

  function collectPageElements(hiddenApplyUrl) {
    elementRegistry = new Map();
    elemSeq = 0;
    const elements = [];

    for (const node of collectActionCandidates()) {
      if (!isActionRendered(node)) continue;
      if (opensFileChooser(node)) continue;
      if (node.tagName === "A") {
        const hrefAttr = node.getAttribute("href") || "";
        if (hrefAttr.startsWith("javascript:") && !node.getAttribute("onclick") && node.getAttribute("role") !== "button") {
          continue;
        }
      }

      const text = actionText(node);
      if (!text) continue;

      let href = resolveHref(node) || "";
      if (href && isForbiddenNavigationUrl(href, location.href)) continue;

      const elementId = `el_${elemSeq++}`;
      node.dataset.jobmateElementId = elementId;
      elementRegistry.set(elementId, node);

      const card = node.closest("article, li, tr, section, form, main") || node.parentElement;
      elements.push({
        elementId,
        type: "action",
        tag: node.tagName.toLowerCase(),
        text,
        href,
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true"),
        context: clean(card?.textContent || "").slice(0, 300)
      });
    }

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
      elements,
      blockedElementIds: [...blockedElementIds],
      overlayMap: []
    });
    if (!reply?.ok) throw new Error(reply?.error || "Analyze failed.");
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

  function labelledText(node) {
    const id = node.getAttribute("id");
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrap = node.closest("label");
    const aria = node.getAttribute("aria-label");
    const labelledBy = clean(
      (node.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((lid) => document.getElementById(lid)?.textContent || "")
        .join(" ")
    );
    return clean(byFor?.textContent || wrap?.textContent || aria || labelledBy || "");
  }

  function nearbyLabel(node) {
    const direct = labelledText(node);
    if (direct && direct.length > 2 && !["yes", "no", "true", "false", "type your response", "select"].includes(direct.toLowerCase())) {
      return direct;
    }
    let cursor = node.parentElement;
    for (let depth = 0; cursor && depth < 7; depth++) {
      const legend = cursor.querySelector("legend");
      const label = cursor.querySelector("label, [class*='label'], [class*='question'], h1, h2, h3, h4, p");
      const text = clean(legend?.textContent || label?.textContent || cursor.textContent || "");
      const options = Array.from(cursor.querySelectorAll("input[type='radio'], input[type='checkbox']"))
        .map((item) => labelledText(item) || item.value).filter(Boolean);
      let candidate = text;
      for (const option of options) {
        candidate = candidate.split(option).join(" ");
      }
      candidate = clean(candidate.replace(/[✱*]/g, " "));
      if (candidate.length > 2 && !["yes", "no", "true", "false"].includes(candidate.toLowerCase())) {
        return candidate.slice(0, 260);
      }
      cursor = cursor.parentElement;
    }
    return direct || node.getAttribute("name") || node.getAttribute("id") || node.getAttribute("placeholder") || "Field";
  }

  function groupOptions(node, type) {
    const name = node.getAttribute("name");
    const group = name
      ? Array.from(document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`))
      : [node];
    return group.map((item) => labelledText(item) || item.value).filter(Boolean);
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

      items.push({
        node,
        field: {
          fieldId,
          key,
          label: lab,
          type,
          required:
            (node.required === true || String(node.getAttribute("aria-required") || "") === "true") ||
            /[✱*]|required/i.test(lab),
          options: tag === "select"
            ? Array.from(node.options).map((opt) => clean(opt.label || opt.text || opt.value)).filter(Boolean)
            : type === "radio" || type === "checkbox"
              ? groupOptions(node, type)
              : []
        }
      });
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

  async function typeText(node, text) {
    node.focus();
    setNativeValue(node, "");
    for (const ch of text) {
      setNativeValue(node, node.value + ch);
      await sleep(8);
    }
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
    if (type === "checkbox") return !node.checked;
    if (type === "radio") {
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
    return !String(node.value ?? "").trim();
  }

  function choiceClickTarget(input) {
    const id = input.id;
    if (id) {
      const linked = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (linked) return linked;
    }
    const wrapped = input.closest("label");
    if (wrapped) return wrapped;
    const parent = input.parentElement;
    if (parent) {
      const siblingLabel = parent.querySelector("label, span, div");
      if (siblingLabel && siblingLabel !== input && isRendered(siblingLabel)) return siblingLabel;
    }
    return input;
  }

  async function activateChoice(input, checked) {
    const target = choiceClickTarget(input);
    await aggressiveClick(target);
    if (checked !== undefined) {
      input.checked = checked;
      if (input.getAttribute("role") === "checkbox" || input.getAttribute("role") === "radio") {
        input.setAttribute("aria-checked", checked ? "true" : "false");
      }
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
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

  function fillSelect(node, answer) {
    const target = norm(answer);
    let picked = null;
    for (const opt of node.options) {
      const labels = [opt.label, opt.text, opt.value].map(norm).filter(Boolean);
      if (labels.some((label) => label === target || label.includes(target) || target.includes(label))) {
        picked = opt;
        break;
      }
    }
    node.focus();
    node.value = picked?.value || answer;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function checkNonDemographicCheckboxes(fieldItems) {
    for (const item of fieldItems) {
      if (item.field.type !== "checkbox") continue;
      if (isDemographicField(item.field)) continue;
      if (item.node.checked) continue;
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
      items.push({
        node: input,
        field: {
          fieldId,
          key,
          label: nearbyLabel(input),
          type: "file",
          required:
            input.required === true ||
            String(input.getAttribute("aria-required") || "") === "true" ||
            /[✱*]|required/i.test(nearbyLabel(input)),
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
    if (text.includes(".pdf") && isResumeLabel(nearbyLabel(input))) return true;
    return false;
  }

  function setInputFiles(input, fileList) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");

    if (descriptor?.set) {
      descriptor.set.call(input, fileList);
      return;
    }

    input.files = fileList;
  }

  async function forceAttachResumeToInput(input, file) {
    const saved = {
      type: input.type,
      hidden: input.hidden,
      disabled: input.disabled,
      style: {
        display: input.style.display,
        visibility: input.style.visibility,
        opacity: input.style.opacity,
        position: input.style.position,
        width: input.style.width,
        height: input.style.height,
        left: input.style.left,
        top: input.style.top,
        pointerEvents: input.style.pointerEvents
      },
      attrs: {
        hidden: input.getAttribute("hidden"),
        ariaHidden: input.getAttribute("aria-hidden"),
        tabIndex: input.getAttribute("tabindex")
      }
    };

    function restoreInput() {
      input.type = saved.type;
      input.hidden = saved.hidden;
      input.disabled = saved.disabled;
      for (const [key, value] of Object.entries(saved.style)) {
        input.style[key] = value;
      }
      if (saved.attrs.hidden === null) input.removeAttribute("hidden");
      else input.setAttribute("hidden", saved.attrs.hidden);
      if (saved.attrs.ariaHidden === null) input.removeAttribute("aria-hidden");
      else input.setAttribute("aria-hidden", saved.attrs.ariaHidden);
      if (saved.attrs.tabIndex === null) input.removeAttribute("tabindex");
      else input.setAttribute("tabindex", saved.attrs.tabIndex);
    }

    function prepareInput() {
      if (input.type !== "file") input.type = "file";
      input.hidden = false;
      input.disabled = false;
      input.removeAttribute("hidden");
      input.removeAttribute("aria-hidden");
      input.style.display = "block";
      input.style.visibility = "visible";
      input.style.opacity = "0.01";
      input.style.position = "fixed";
      input.style.left = "0";
      input.style.top = "0";
      input.style.width = "4px";
      input.style.height = "4px";
      input.style.pointerEvents = "auto";
      input.tabIndex = 0;
    }

    function dispatchFileEvents(target) {
      target.dispatchEvent(new Event("focus", { bubbles: true }));
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      target.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    async function assignFiles(target) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      setInputFiles(target, transfer.files);
      dispatchFileEvents(target);
    }

    async function tryDrop(target) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const zone = target.closest(
        "label, [role='button'], button, [class*='upload'], [class*='drop'], [class*='file'], [class*='File'], form, section, div"
      ) || target;
      zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      await assignFiles(target);
    }

    const attempts = [
      async () => {
        prepareInput();
        input.focus();
        await assignFiles(input);
      },
      async () => {
        prepareInput();
        await tryDrop(input);
      }
    ];

    try {
      for (const attempt of attempts) {
        await attempt();
        await sleep(120);
        if (fileInputHasResume(input)) {
          return true;
        }
      }
      return fileInputHasResume(input);
    } finally {
      restoreInput();
    }
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
    if (!resumeFieldIds.length) {
      payload._resumeAttachDone = true;
      return;
    }
    if (!payload.resumeUpload?.base64) return;
    const resume = base64ToFile(payload.resumeUpload);
    const coverSet = new Set(coverLetterFieldIds || []);
    const resumeInputs = collectResumeInputs(fieldItems, resumeFieldIds).filter((input) => {
      const item = fieldItems.find((entry) => entry.node === input);
      const fieldId = item?.field.fieldId || "";
      return fieldId && !coverSet.has(fieldId);
    });
    for (const input of resumeInputs) {
      if (fileInputHasResume(input) || resumeUploadLooksComplete(input, payload)) continue;
      let ok = await forceAttachResumeToInput(input, resume);
      if (!ok) {
        await sleep(400);
        await forceAttachResumeToInput(input, resume);
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
      const input = item.node;
      const transfer = new DataTransfer();
      transfer.items.add(coverFile);
      setInputFiles(input, transfer.files);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  async function fillControl(item, answer, fast) {
    const node = item.node;
    const type = item.field.type;
    const tag = node.tagName.toLowerCase();
    if (type === "file") return;

    if (type === "checkbox" && !answer && !isDemographicField(item.field)) {
      if (!node.checked) {
        node.focus();
        await activateChoice(node, true);
      }
      return;
    }

    if (!answer) return;

    if (type === "contenteditable") {
      node.focus();
      node.textContent = answer;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (type === "radio" || type === "checkbox") {
      await choose(node, answer, type === "checkbox");
    } else if (tag === "select") {
      fillSelect(node, answer);
    } else if (fast) {
      node.focus();
      setNativeValue(node, answer);
    } else {
      await typeText(node, answer);
    }
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
      await fillControl(item, answer, true);
    }
  }

  async function ensureRequiredChoicesFilled(fieldItems, answers) {
    for (const item of fieldItems) {
      if (item.field.type === "file") continue;
      if (item.field.type === "checkbox") {
        if (isDemographicField(item.field)) continue;
        if (!item.node.checked) await activateChoice(item.node, true);
        continue;
      }
      if (item.field.type === "radio") {
        const answer = answers.get(item.field.fieldId) || "";
        if (answer) await choose(item.node, answer, false);
        else if (item.field.required && fieldLooksEmpty(item)) {
          await activateChoice(item.node, true);
        }
        continue;
      }
      if (fieldLooksEmpty(item)) {
        const answer = answers.get(item.field.fieldId) || "";
        if (answer) await fillControl(item, answer, true);
      }
    }
  }

  function unresolvedFieldItems(fieldItems) {
    return fieldItems.filter((item) => item.field.type !== "file" && fieldLooksEmpty(item));
  }

  async function retryEmptyApplicationFields(fieldItems, payload, pageLanguage) {
    const emptyItems = unresolvedFieldItems(fieldItems);
    if (!emptyItems.length) return;

    const requiredEmpty = emptyItems.filter((item) => item.field.required);
    const retryNote = requiredEmpty.length
      ? `CRITICAL — ${requiredEmpty.length} REQUIRED FIELD(S) ARE STILL BLANK. This is a 5-alarm failure. You MUST provide a non-empty answer for every single field listed below. For dropdowns and radio groups, pick the best available option from the options list — returning free text or an empty string is absolutely forbidden. Required fields cannot be skipped under any circumstances. Fill location, visa sponsorship, work authorization, source/how-heard, and all dropdown/checkbox fields. Use every available piece of candidate context and the resume PDF. Required empty fields: ${requiredEmpty.map((i) => `"${i.field.label}" (type=${i.field.type}${i.field.options?.length ? `, options: ${i.field.options.slice(0, 6).join(" | ")}` : ""})`).join("; ")}`
      : "These fields are still empty on the page. You MUST provide a non-empty answer for every field listed. Fill location, visa sponsorship, work authorization, source/how-heard, dropdowns, and checkbox consent fields. Use candidate context and the resume PDF.";

    panel(["JobMate", `Retrying ${emptyItems.length} empty field(s)${requiredEmpty.length ? ` (${requiredEmpty.length} required)` : ""}…`]);
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
      if (answer) await fillControl(item, answer, true);
    }
    await checkNonDemographicCheckboxes(fieldItems);
    return retryAnswers;
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
              await fillControl(item, payload.coverLetterText, true);
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
    const { first, last } = splitFullName(payload.candidateFullName);
    const email = payload.candidateEmail.trim();
    const fullName = payload.candidateFullName.trim() || `${first} ${last}`.trim();

    for (const item of fieldItems) {
      const type = item.field.type;
      const label = norm(item.field.label);

      if (type === "email" || label.includes("email")) {
        await fillControl(item, email, true);
      } else if (type === "password" || label.includes("password")) {
        await fillControl(item, password, true);
      } else if (label.includes("first") && label.includes("name")) {
        await fillControl(item, first, true);
      } else if (label.includes("last") && label.includes("name")) {
        await fillControl(item, last, true);
      } else if (label.includes("name") && !label.includes("user")) {
        await fillControl(item, fullName, true);
      } else if (type === "checkbox") {
        if (item.node.required || label.includes("agree") || label.includes("terms") || label.includes("consent")) {
          if (!item.node.checked) {
            item.node.click();
            item.node.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      }
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
            await fillControl(selectedItem, answer, true);
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
    if (action.tool === "navigate" && action.url) {
      await recordPlaybookStep(pageUrl, fieldCount, "navigate", null, action.url);
      return;
    }
    if (action.tool !== "click" && action.tool !== "submit") return;
    const elemEntry = elements.find((e) => e.elementId === action.elementId);
    if (!elemEntry) return;
    await recordPlaybookStep(pageUrl, fieldCount, action.tool, elemEntry);
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

  function isApplicationFormPage(elements) {
    const fields = elements.filter((e) => e.type === "field");
    if (!fields.length) return false;
    const hasPassword = fields.some((f) => f.fieldType === "password");
    if (hasPassword) return false;
    return true;
  }

  function isAuthFormPage(elements) {
    const fields = elements.filter((e) => e.type === "field");
    if (!fields.length) return false;
    const hasPassword = fields.some((f) => f.fieldType === "password");
    if (!hasPassword) return false;
    return !isApplicationFormPage(elements);
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
    if (u === urlPingPongTrack.last) return urlPingPongTrack.switches >= 2;
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
      return urlPingPongTrack.switches >= 2;
    }
    return false;
  }

  async function stopUrlPingPong() {
    await requestHumanHelp(
      "Stopped: the page kept switching between the same two URLs.",
      "Open the job application page directly, then click Continue."
    );
  }

  function isSubmitLike(node, action) {
    const t = (node.getAttribute("type") || node.type || "").toLowerCase();
    const text = clean(node.textContent || node.value || "").toLowerCase();
    const autoId = (node.getAttribute("data-automation-id") || "").toLowerCase();
    return t === "submit" || autoId.includes("submit") || /^(sign in|log in|login|register|create account|submit|continue|next|send)$/i.test(text);
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

    async function checkStuck(stateBefore, instruction, taskKey) {
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
        failuresByState.set(stateBefore, 0);
        failedTaskAttempts.set(stuckTaskKey, 0);
        const userInstruction = await requestHumanHelp(
          lastReason || "The agent is stuck on this step.",
          instruction || "Please complete this step manually, then click Continue."
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
          pending.instruction || "Complete what is needed to unblock, then click Continue."
        );
        history.push({ step: history.length, tool: "human_interrupt", reasoning: pending.reason || "Interrupted by user." });
        if (userInstruction) {
          history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
        }
        continue;
      }

      await waitForPageLoad();

      if (recordUrlPingPong(location.href)) {
        await stopUrlPingPong();
        continue;
      }

      if (pageHostName() === "workatastartup.com") {
        try {
          if (isWorkAtAStartupApplicantPortalPath(new URL(location.href).pathname)) {
            await requestHumanHelp(
              "Blocked: landed on Work at a Startup account/profile page.",
              "Use the browser back button to return to the job listing (/jobs/…), then click Continue."
            );
            continue;
          }
        } catch { }
      }

      let hiddenApplyUrl = extractHiddenApplyUrl();
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
      const stateBefore = pageStateKey(fieldItems.length);
      const formKey = stateBefore;

      if (fieldItems.length > 0 && !handledForms.has(formKey)) {
        if (isApplicationFormPage(elements)) {
          if (!(await verifyRunner(payloadUrl))) {
            return;
          }
          handledForms.add(formKey);
          failuresByState.delete(stateBefore);
          await fillApplicationForm(payload);
          history.push({ step, tool: "form_fill", reasoning: `filled ${fieldItems.length} fields` });
          continue;
        }

        if (isAuthFormPage(elements)) {
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
              stateBefore,
              "Please submit the login/registration form manually, then click Continue.",
              `auth_submit|${stateBefore}`
            );
          }
          continue;
        }
      }

      const pageUrlBefore = location.href;
      const fieldCountBefore = fieldItems.length;
      panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Navigating…"]);
      const action = await callStep(step, history, hiddenApplyUrl, elements, blockedElementIds);
      if (action.fromPlaybook) {
        panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Known path…"]);
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
          "Please complete this step manually, then click Continue."
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
        await checkStuck(stateBefore, "Please complete this step manually, then click Continue.", `wait|${stateBefore}`);
        continue;
      }

      if (action.tool === "navigate" && action.url) {
        if (isForbiddenNavigationUrl(action.url, location.href)) {
          blockedElementIds.add(action.elementId || `nav:${action.url}`);
          const userInstruction = await requestHumanHelp(
            "Blocked forbidden navigation.",
            "Return to the job listing and click Apply there, then click Continue."
          );
          if (userInstruction) {
            history.push({ step: history.length, tool: "human_instruction", reasoning: userInstruction });
          }
          continue;
        }
        statusPanel(step, MAX_STEPS, action);
        await rememberPlaybookStep(pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
        if (navigateNow(action.url)) return;
        history.push({ ...histEntry, reasoning: "already on target page" });
        await checkStuck(
          stateBefore,
          "Please navigate or complete this step manually, then click Continue.",
          `navigate|${action.url || stateBefore}`
        );
        continue;
      }

      if (action.tool === "submit" && action.elementId) {
        await showConfirmPanel();
        const ok = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
        if (ok === "navigated") return;
        history.push(histEntry);
        if (!ok) blockedElementIds.add(action.elementId);
        return;
      }

      if (action.tool === "click" && action.elementId) {
        const ok = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
        if (ok === "navigated") {
          await rememberPlaybookStep(pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
          lastFormFill = null;
          return;
        }
        history.push(histEntry);
        if (ok) {
          failuresByState.delete(stateBefore);
          await rememberPlaybookIfAdvanced(stateBefore, pageUrlBefore, fieldCountBefore, action, elements).catch(() => { });
        } else {
          blockedElementIds.add(action.elementId);
        }

        await sleep(600);
        const { fieldItems: fieldsAfterClick } = collectPageElements(null);
        const stateAfterClick = pageStateKey(fieldsAfterClick.length);
        const pageStuck = stateAfterClick === stateBefore;

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

          if (validateResult?.ok && validateResult.corrections?.length) {
            for (const item of fill.fieldItems) {
              const corr = validateResult.corrections.find((entry) => entry.fieldId === item.field.fieldId);
              if (corr?.answer) {
                await fillControl(item, corr.answer, true);
                fill.answers.set(item.field.fieldId, corr.answer);
              }
            }
            lastFormFill = fill;
            if (action.elementId) {
              const retryOk = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
              if (retryOk === "navigated") return;
            }
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

          panel(["JobMate", "Form failed — retrieving from AI…"]);

          const explainResult = await extensionMessage({
            type: "JOBMATE_EXPLAIN_PLACEMENTS",
            placements: placementReport,
            validationErrors
          }).catch(() => null);

          if (explainResult?.ok && Array.isArray(explainResult.explanations)) {
            const lines = explainResult.explanations.map((e) =>
              `Field: "${e.label}" (${e.type})\nPlaced: ${JSON.stringify(e.answer)}\nReason: ${e.reasoning}\nCorrection: ${JSON.stringify(e.correctedAnswer)}`
            );
            panel(["JobMate — AI Placement Audit", ...lines.slice(0, 6)]);
            await sleep(1200);

            for (const item of fill.fieldItems) {
              const exp = explainResult.explanations.find((e) => e.fieldId === item.field.fieldId);
              if (exp?.correctedAnswer && exp.correctedAnswer !== exp.answer) {
                await fillControl(item, exp.correctedAnswer, true);
                fill.answers.set(item.field.fieldId, exp.correctedAnswer);
              }
            }
          }
        }

        await checkStuck(
          stateBefore,
          "Please click the required button manually, then click Continue.",
          `click|${action.elementId || stateBefore}`
        );
        continue;
      }

      history.push(histEntry);
      await checkStuck(stateBefore, "Please complete this step manually, then click Continue.", `${action.tool}|${stateBefore}`);
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
            : "Complete what is needed to unblock, then click Continue."
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
