(function () {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function extensionMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const last = chrome.runtime.lastError;
        if (last) {
          reject(new Error(last.message || "Extension messaging failed"));
          return;
        }
        resolve(response || {});
      });
    });
  }

  async function resolvePayloadUrl() {
    const sessionId = hash.get("jobmateSession");
    if (sessionId) {
      history.replaceState(null, document.title, location.pathname + location.search);
      const payloadUrl = `ext://session/${sessionId}`;
      await extensionMessage({ type: "JOBMATE_APPLY_SESSION_SET", payloadUrl }).catch(() => {});
      return payloadUrl;
    }
    const fromHash = hash.get("jobmatePayload");
    if (fromHash) {
      history.replaceState(null, document.title, location.pathname + location.search);
      await extensionMessage({ type: "JOBMATE_APPLY_SESSION_SET", payloadUrl: fromHash }).catch(() => {});
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
    } catch {}
    return raw.replace(/\/payload\/?(\?.*)?$/i, `/${segment}$1`);
  }

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const demographicPattern = /\b(pronouns?|race|ethnicity|gender|disabilit(?:y|ies)|veteran|eeo|equal opportunity|hispanic|latino|self identify|self-identify)\b/i;
  const optOutPattern = /\b(do not wish|don't wish|do not want|don't want|prefer not|decline|choose not|not disclose|no answer|wish not)\b/i;

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
        try { return new URL(match[1].replace(/\\\//g, "/")).toString(); } catch {}
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

  function isProfileAction(text, href) {
    const token = norm(text);
    if (/\b(profile|my account|account settings|view profile|edit profile|complete your profile|your profile|mon compte|profil)\b/i.test(token)) {
      return true;
    }
    try {
      const path = new URL(href, location.href).pathname.toLowerCase();
      return /\/profile\b|\/profiles\b|\/account\b|\/users\/(?:sign|edit)/i.test(path);
    } catch {
      return false;
    }
  }

  function applyActionScore(element, node) {
    const text = clean(element.text || "");
    const token = norm(text);
    const href = element.href || resolveHref(node) || "";

    if (!token || text.length > 80) return -999;
    if (isProfileAction(text, href)) return -999;
    if (/\b(save|saved|bookmark|share|login|log in|sign in|sign up|cookie|privacy|cancel|close|view listing|view job|back|home|menu|mon compte)\b/i.test(token)) {
      return -999;
    }

    let score = 0;
    if (/^apply now$/i.test(text.trim())) score += 120;
    else if (/^apply$/i.test(text.trim())) score += 110;
    else if (/^apply\b/i.test(token)) score += 95;
    else if (/\bapply now\b/i.test(token)) score += 90;
    else if (/\bapply for\b/i.test(token)) score += 85;
    else if (/\bapply\b/i.test(token)) score += 75;
    else if (/\b(start application|submit application|continue application)\b/i.test(token)) score += 50;

    if (element.tag === "button" || element.tag === "input") score += 15;
    if (/\b(btn|button|primary|cta)\b/i.test(String(node.className || ""))) score += 10;

    const rect = node.getBoundingClientRect?.();
    if (rect && rect.width * rect.height > 5000) score += 8;

    return score;
  }

  function findPrimaryApplyAction(elements) {
    let best = null;
    let bestScore = 0;

    for (const element of elements) {
      if (element.type !== "action") continue;
      const node = nodeByElementId(element.elementId);
      if (!node) continue;
      const score = applyActionScore(element, node);
      if (score >= 75 && score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    return best;
  }

  function navigateNow(href) {
    if (!href || normalizeHref(href) === normalizeHref(location.href)) {
      return false;
    }
    location.assign(href);
    return true;
  }

  async function activateElement(payloadUrl, elementId, elements, actionMeta) {
    const node = nodeByElementId(elementId);
    if (!node) return false;

    const elemEntry = elements.find((e) => e.elementId === elementId);
    const elemText = elemEntry?.text || clean(node.textContent || "");
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

    await aggressiveClick(node);
    return true;
  }

  function nodeByElementId(elementId) {
    return elementRegistry.get(elementId) || null;
  }

  async function waitForPageLoad() {
    const deadline = Date.now() + 12000;
    while (document.readyState !== "complete" && Date.now() < deadline) {
      await sleep(200);
    }
    let lastHtml = document.body?.innerHTML?.length ?? 0;
    let stable = 0;
    while (stable < 3 && Date.now() < deadline) {
      await sleep(300);
      const cur = document.body?.innerHTML?.length ?? 0;
      if (cur === lastHtml) stable++;
      else { stable = 0; lastHtml = cur; }
    }
  }


  function collectPageElements(hiddenApplyUrl) {
    elementRegistry = new Map();
    elemSeq = 0;
    const elements = [];

    const actionNodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"], [role="tab"], input[type="button"], input[type="submit"]')
    );

    for (const node of actionNodes) {
      const text = clean(
        [node.textContent || "", node.getAttribute("aria-label") || "", node.getAttribute("data-testid") || "", node.getAttribute("title") || ""].join(" ")
      );
      if (!text || text.length > 200) continue;

      let href = resolveHref(node) || "";
      if (isProfileAction(text, href)) continue;
      if (!href && hiddenApplyUrl) {
        const parentText = clean(node.closest("section, article, main, form, div")?.textContent || "");
        if (parentText.length > 5) href = "";
      }

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

  async function callStep(step, history, hiddenApplyUrl, elements) {
    const reply = await extensionMessage({
      type: "JOBMATE_ANALYZE_PAGE",
      pageUrl: location.href,
      pageText: clean(document.body?.textContent || "").slice(0, 2500),
      stepIndex: step,
      history,
      hiddenApplyUrl: hiddenApplyUrl || null,
      elements
    });
    if (!reply?.ok) throw new Error(reply?.error || "Analyze failed.");
    return reply.action;
  }

  function fieldRoots() {
    const roots = [document];
    for (const iframe of document.querySelectorAll("iframe")) {
      try {
        const doc = iframe.contentDocument;
        if (doc) roots.push(doc);
      } catch {}
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

    for (const root of fieldRoots()) {
      for (const node of queryDeep("input, textarea, select", root)) {
        const tag = node.tagName.toLowerCase();
        const type = tag === "input" ? String(node.type || "text").toLowerCase() : tag;
        if (["hidden", "button", "submit", "reset", "image"].includes(type)) continue;
        pushField(node, type, tag);
      }
    }

    for (const root of fieldRoots()) {
      for (const node of queryDeep("[contenteditable=true]", root)) {
        if (node.querySelector("[contenteditable=true]")) continue;
        if (node.querySelector("input, textarea, select")) continue;
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

    focusTarget.scrollIntoView({ block: "center", inline: "center" });
    focusTarget.focus();

    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, view: window };
    focusTarget.dispatchEvent(new KeyboardEvent("keydown", opts));
    focusTarget.dispatchEvent(new KeyboardEvent("keypress", opts));
    focusTarget.dispatchEvent(new KeyboardEvent("keyup", opts));

    if (form && typeof form.requestSubmit === "function") {
      try { form.requestSubmit(); } catch {}
    }
  }

  async function aggressiveClick(node) {
    const savedAriaHidden = node.getAttribute("aria-hidden");
    const savedTabindex = node.getAttribute("tabindex");
    const savedDisabled = node.disabled;
    const savedAriaDisabled = node.getAttribute("aria-disabled");

    if (savedAriaHidden) node.removeAttribute("aria-hidden");
    if (savedTabindex && parseInt(savedTabindex) < 0) node.setAttribute("tabindex", "0");
    if (savedDisabled) node.disabled = false;
    if (savedAriaDisabled === "true") node.setAttribute("aria-disabled", "false");

    node.scrollIntoView({ block: "center", inline: "center" });
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

  function choose(node, answer, multi) {
    const name = node.getAttribute("name");
    const group = name
      ? Array.from(document.querySelectorAll(`input[type="${node.type}"][name="${CSS.escape(name)}"]`))
      : [node];
    const wanted = answer.split(/[\n,;]/).map(norm).filter(Boolean);
    for (const item of group) {
      const label = norm(`${labelledText(item)} ${item.value}`);
      const match = wanted.some((part) => label.includes(part) || part.includes(label));
      if (match) {
        item.focus();
        item.click();
        item.dispatchEvent(new Event("change", { bubbles: true }));
        if (!multi) return;
      }
    }
  }

  function optOutAnswer(field) {
    if (!field.required || !["radio", "checkbox", "select"].includes(field.type) || !demographicPattern.test(field.label)) {
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
        if (!seen.has(node)) {
          seen.add(node);
          inputs.push(node);
        }
      }
    }

    return inputs;
  }

  function fileInputHasResume(input) {
    const files = input.files;
    return Boolean(files && files.length > 0);
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
    input.scrollIntoView({ block: "center", inline: "center" });

    const transfer = new DataTransfer();
    transfer.items.add(file);
    const fileList = transfer.files;

    const attempts = [
      async () => {
        setInputFiles(input, fileList);
      },
      async () => {
        const zone = input.closest(
          "label, [role='button'], button, [class*='upload'], [class*='drop'], [class*='file'], [class*='File']"
        );
        if (zone && zone !== input) {
          await aggressiveClick(zone);
          await sleep(120);
        }
        setInputFiles(input, fileList);
      },
      async () => {
        const id = input.getAttribute("id");
        if (id) {
          const root = input.getRootNode();
          const scope = root instanceof Document ? root : root;
          const label = scope.querySelector?.(`label[for="${CSS.escape(id)}"]`);
          if (label) {
            await aggressiveClick(label);
            await sleep(120);
          }
        }
        setInputFiles(input, fileList);
      }
    ];

    for (const attempt of attempts) {
      await attempt();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      await sleep(80);
      if (fileInputHasResume(input)) {
        return true;
      }
    }

    return fileInputHasResume(input);
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

  async function attachFiles(fileInputs, payload, resumeElementIds, coverLetterFileIds, uploadCoverAsFile) {
    const resume = payload.resumeUpload ? base64ToFile(payload.resumeUpload) : null;
    const coverFile = uploadCoverAsFile ? coverLetterUploadFile(payload) : null;
    const resumeSet = new Set(resumeElementIds || []);
    const coverSet = new Set(coverLetterFileIds || []);
    const resumeTargets = [];
    const failedResume = [];

    for (const input of fileInputs) {
      const fieldId = input.dataset.jobmateFieldId || "";

      if (isCoverLetterFileInput(input)) {
        if (!uploadCoverAsFile || !coverFile || !coverSet.has(fieldId)) continue;
        const transfer = new DataTransfer();
        transfer.items.add(coverFile);
        setInputFiles(input, transfer.files);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        continue;
      }

      if (!resumeSet.has(fieldId)) continue;
      if (!resume) {
        failedResume.push(nearbyLabel(input) || fieldId || "resume");
        continue;
      }

      resumeTargets.push(input);
    }

    for (const input of resumeTargets) {
      const label = nearbyLabel(input) || input.getAttribute("name") || "resume";
      const ok = await forceAttachResumeToInput(input, resume);
      if (!ok) {
        failedResume.push(label);
      }
    }

    if (failedResume.length) {
      await requestHumanHelp(
        `Resume PDF could not be attached to: ${failedResume.join(", ")}`,
        "Please attach your resume/CV manually, then click Continue."
      );
    }
  }

  async function fillControl(item, answer, fast) {
    const node = item.node;
    const type = item.field.type;
    const tag = node.tagName.toLowerCase();
    if (!answer || type === "file") return;

    if (type === "contenteditable") {
      node.focus();
      node.textContent = answer;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (type === "radio" || type === "checkbox") {
      choose(node, answer, type === "checkbox");
    } else if (tag === "select") {
      const value = Array.from(node.options).find(
        (opt) => norm(opt.label || opt.text || opt.value) === norm(answer)
      );
      node.value = value?.value || answer;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (fast) {
      node.focus();
      setNativeValue(node, answer);
    } else {
      await typeText(node, answer);
    }
  }

  function classifyResumeAttachmentFields(fieldItems, llmResumeFieldIds) {
    const llmSet = new Set(llmResumeFieldIds || []);
    const resumeElementIds = [];
    for (const item of fieldItems) {
      if (item.field.type !== "file") continue;
      if (llmSet.has(item.field.fieldId)) {
        resumeElementIds.push(item.field.fieldId);
      }
    }
    return resumeElementIds;
  }

  async function fillApplicationForm(payload) {
    panel(["JobMate", "Opening cover letter text entry…"]);
    const manualReveal = await revealCoverLetterManualEntry();
    const fieldItems = controls();
    const coverLetterFileIds = classifyCoverLetterFileFields(fieldItems);
    const uploadCoverAsFile =
      coverLetterFileIds.length > 0 && (!manualReveal || !hasCoverLetterTextField(fieldItems));

    panel(["JobMate", `Generating answers for ${fieldItems.length} fields…`]);
    const answersPayload = await extensionMessage({
      type: "JOBMATE_FILL_ANSWERS",
      fields: fieldItems.map((item) => item.field),
      pageLanguage: detectPageLanguage()
    });
    if (!answersPayload?.ok) throw new Error(answersPayload?.error || "Answers generation failed.");

    const resumeElementIds = classifyResumeAttachmentFields(fieldItems, answersPayload.resumeFieldIds || []);
    const answers = new Map((answersPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));

    for (const item of fieldItems) {
      const current = answers.get(item.field.fieldId) || "";
      const optOut = optOutAnswer(item.field);
      if (optOut && (!current || !item.field.options.some((opt) => norm(opt) === norm(current)))) {
        answers.set(item.field.fieldId, optOut);
      }
    }

    payload.coverLetterText = answersPayload.coverLetterText || payload.coverLetterText || "";

    panel(["JobMate", `Filling ${fieldItems.length} fields…`]);
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

    const skippedItems = fieldItems.filter((item) => {
      if (item.field.type === "file") return false;
      if (isCoverLetterTextField(item)) return false;
      const answer = answers.get(item.field.fieldId) || "";
      if (answer) return false;
      const val = item.node.value !== undefined ? String(item.node.value || "").trim() : "";
      if (val) return false;
      return true;
    });

    if (skippedItems.length > 0) {
      panel(["JobMate", `Retrying ${skippedItems.length} empty field(s)…`]);
      const retryPayload = await extensionMessage({
        type: "JOBMATE_FILL_ANSWERS",
        fields: skippedItems.map((item) => item.field),
        pageLanguage: detectPageLanguage(),
        retryNote: `These fields were left empty in the first pass. You MUST provide a non-empty answer for every field listed. Use every piece of candidate context available, including the resume PDF. Leaving any field empty is not permitted.`
      }).catch(() => null);

      if (retryPayload?.ok) {
        const retryAnswers = new Map((retryPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));
        for (const item of skippedItems) {
          const answer = retryAnswers.get(item.field.fieldId) || "";
          if (answer) await fillControl(item, answer, true);
        }
      }
    }

    if (!payload.coverLetterText?.trim() && (coverLetterFileIds.length > 0 || hasCoverLetterTextField(fieldItems))) {
      throw new Error("Application form requires a cover letter but none was generated.");
    }

    const fileInputs = collectAllFileInputs();
    const resumeRequired = resumeElementIds.length > 0;

    if (resumeRequired && !payload.resumeUpload?.base64) {
      throw new Error("Application form requires a resume upload but no resume is on file.");
    }

    await attachFiles(fileInputs, payload, resumeElementIds, coverLetterFileIds, uploadCoverAsFile);
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
    const { id, statusLines, btnLabel, btnColor, onConfirm, alertTitle } = options;

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
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Working…";
        await onConfirm?.();
        wrap.remove();
        resolve();
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
    }).catch(() => {});

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
        await extensionMessage({ type: "JOBMATE_SESSION_COMPLETE", applicationUrl: location.href }).catch(() => {});
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

  async function requestHumanHelp(whatHappened, instruction) {
    await extensionMessage({
      type: "JOBMATE_APPLY_NEEDS_ATTENTION",
      message: whatHappened,
      instruction,
      applyUrl: location.href
    }).catch(() => {});

    const result = await showActionPanel({
      id: "jobmate-help-wrap",
      statusLines: ["⚠ JobMate needs your help", whatHappened, instruction],
      btnLabel: "Continue",
      btnColor: "#b45309",
      alertTitle: "Needs attention",
      onConfirm: null
    });
    resetUrlPingPongTrack();
    await extensionMessage({ type: "JOBMATE_RESET_URL_OSCILLATION" }).catch(() => {});
    return result;
  }

  function panel(lines) {
    let box = document.getElementById("jobmate-status");
    if (!box) {
      box = document.createElement("div");
      box.id = "jobmate-status";
      box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111827;color:white;padding:12px 14px;border-radius:8px;max-width:400px;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25);white-space:pre-wrap";
      document.body.appendChild(box);
    }
    box.textContent = Array.isArray(lines) ? lines.filter(Boolean).join("\n") : lines;
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
    const hasFile = fields.some((f) => f.fieldType === "file");
    const hasTextarea = fields.some((f) => f.fieldType === "textarea" || f.fieldType === "contenteditable");
    if (hasFile || hasTextarea) return true;
    if (hasPassword && fields.length < 8) return false;
    return fields.length >= 8;
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

  function jobIdFromApplyUrl(url) {
    const match = String(url || "").match(/\/jobs\/(\d+)/i);
    return match?.[1] || "";
  }

  function pageLooksLikeJobListingIndex() {
    let count = 0;
    for (const anchor of document.querySelectorAll('a[href*="/jobs/"]')) {
      count += 1;
      if (count >= 3) return true;
    }
    return false;
  }

  const urlPingPongTrack = { a: null, b: null, last: null, switches: 0 };
  let listingAutoNavigateUsed = false;

  function resetUrlPingPongTrack() {
    urlPingPongTrack.a = null;
    urlPingPongTrack.b = null;
    urlPingPongTrack.last = null;
    urlPingPongTrack.switches = 0;
  }

  function recordUrlPingPong(href) {
    const u = normalizeHref(href);
    if (!u) return false;
    if (u === urlPingPongTrack.last) return urlPingPongTrack.switches >= 3;
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
      return urlPingPongTrack.switches >= 3;
    }
    return false;
  }

  async function stopUrlPingPong() {
    await requestHumanHelp(
      "Stopped: the page kept switching between the same two URLs.",
      "Open the job application page directly, then click Continue."
    );
  }

  function navigateToTargetListingIfNeeded(applyUrl) {
    const targetNorm = normalizeHref(applyUrl);
    if (normalizeHref(location.href) === targetNorm) {
      return false;
    }

    const host = location.hostname.replace(/^www\./i, "").toLowerCase();
    const onCompany = /\/companies\//i.test(location.pathname);
    const targetIsJob = /\/jobs\//i.test(applyUrl);
    if (host === "workatastartup.com" && onCompany && targetIsJob) {
      if (listingAutoNavigateUsed || urlPingPongTrack.switches >= 1) {
        return false;
      }
      listingAutoNavigateUsed = true;
    }

    const targetJobId = jobIdFromApplyUrl(applyUrl);
    let matchedHref = null;

    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = resolveHref(anchor);
      if (!href) continue;
      if (normalizeHref(href) === targetNorm) {
        return navigateNow(href);
      }
      if (targetJobId && jobIdFromApplyUrl(href) === targetJobId) {
        matchedHref = href;
      }
    }

    if (matchedHref) {
      return navigateNow(matchedHref);
    }

    return false;
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
    const MAX_STEPS = 30;
    const STUCK_THRESHOLD = 2;
    let lastReason = "";

    async function checkStuck(stateBefore, instruction) {
      await sleep(400);
      const { fieldItems: fieldsAfter } = collectPageElements(null);
      const stateAfter = pageStateKey(fieldsAfter.length);
      if (stateAfter !== stateBefore) {
        failuresByState.delete(stateBefore);
        return;
      }
      const attempts = (failuresByState.get(stateBefore) || 0) + 1;
      failuresByState.set(stateBefore, attempts);
      if (attempts >= STUCK_THRESHOLD) {
        failuresByState.set(stateBefore, 0);
        await requestHumanHelp(
          lastReason || "The agent is stuck on this step.",
          instruction || "Please complete this step manually, then click Continue."
        );
        history.push({ step: history.length, tool: "human_unblocked", reasoning: "user resolved stuck state" });
      }
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      if (!(await verifyRunner(payloadUrl))) {
        return;
      }

      await waitForPageLoad();

      if (recordUrlPingPong(location.href)) {
        await stopUrlPingPong();
        continue;
      }

      const targetApplyUrl = String(payload.applyUrl || "").trim();
      if (
        targetApplyUrl &&
        (pageLooksLikeJobListingIndex() || normalizeHref(location.href) !== normalizeHref(targetApplyUrl))
      ) {
        if (navigateToTargetListingIfNeeded(targetApplyUrl)) {
          return;
        }
      }

      const hiddenApplyUrl = extractHiddenApplyUrl();
      const { elements, fieldItems } = collectPageElements(hiddenApplyUrl);
      const stateBefore = pageStateKey(fieldItems.length);
      const formKey = stateBefore;

      if (fieldItems.length > 0 && !handledForms.has(formKey)) {
        if (isApplicationFormPage(elements)) {
          if (!(await verifyRunner(payloadUrl))) {
            return;
          }
          handledForms.add(formKey);
          failuresByState.delete(stateBefore);
          panel(["JobMate", `Application form — ${fieldItems.length} fields`, "Generating answers…"]);
          await fillApplicationForm(payload);
          await showConfirmPanel();
          return;
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
            await checkStuck(stateBefore, "Please submit the login/registration form manually, then click Continue.");
          }
          continue;
        }
      }

      if (!isApplicationFormPage(elements) && !isAuthFormPage(elements)) {
        const applyAction = findPrimaryApplyAction(elements);
        if (applyAction) {
          const histEntry = {
            step,
            tool: "click",
            reasoning: `Apply button: ${applyAction.text}`,
            elementId: applyAction.elementId,
            url: null
          };
          lastReason = histEntry.reasoning;
          panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Clicking Apply…"]);
          const ok = await activateElement(payloadUrl, applyAction.elementId, elements, {
            step,
            maxSteps: MAX_STEPS,
            action: { tool: "click", elementId: applyAction.elementId, url: null, reasoning: histEntry.reasoning }
          });
          if (ok === "navigated") return;
          history.push(histEntry);
          if (ok) failuresByState.delete(stateBefore);
          await checkStuck(stateBefore, "Please click Apply manually, then click Continue.");
          continue;
        }
      }

      panel([`JobMate · step ${step + 1}/${MAX_STEPS}`, "Navigating…"]);
      const action = await callStep(step, history, hiddenApplyUrl, elements);
      const histEntry = {
        step,
        tool: action.tool,
        reasoning: action.reasoning,
        elementId: action.elementId ?? null,
        url: action.url ?? null
      };
      lastReason = action.reasoning || "";

      if (action.tool === "blocked") {
        await requestHumanHelp(
          action.reasoning || "The agent is blocked.",
          "Please complete this step manually, then click Continue."
        );
        history.push({ ...histEntry, tool: "human_unblocked" });
        failuresByState.delete(stateBefore);
        continue;
      }

      if (action.tool === "wait") {
        statusPanel(step, MAX_STEPS, action, "Waiting for page…");
        history.push(histEntry);
        await checkStuck(stateBefore, "Please complete this step manually, then click Continue.");
        continue;
      }

      if (action.tool === "navigate" && action.url) {
        statusPanel(step, MAX_STEPS, action);
        if (navigateNow(action.url)) return;
        history.push({ ...histEntry, reasoning: "already on target page" });
        await checkStuck(stateBefore, "Please navigate or complete this step manually, then click Continue.");
        continue;
      }

      if (action.tool === "click" && action.elementId) {
        const ok = await activateElement(payloadUrl, action.elementId, elements, { step, maxSteps: MAX_STEPS, action });
        if (ok === "navigated") return;
        history.push(histEntry);
        if (ok) failuresByState.delete(stateBefore);
        await checkStuck(stateBefore, "Please click the required button manually, then click Continue.");
        continue;
      }

      history.push(histEntry);
      await checkStuck(stateBefore, "Please complete this step manually, then click Continue.");
    }

    panel(["JobMate: step limit reached", "Could not reach application form."]);
  }

  run().catch((err) => panel(`JobMate error: ${err?.message ?? String(err)}`));
})();
