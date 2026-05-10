(function () {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const payloadUrl = hash.get("jobmatePayload");

  if (!payloadUrl) {
    return;
  }

  history.replaceState(null, document.title, location.pathname + location.search);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const norm = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const demographicPattern = /\b(pronouns?|race|ethnicity|gender|disabilit(?:y|ies)|veteran|eeo|equal opportunity|hispanic|latino|self identify|self-identify)\b/i;
  const optOutPattern = /\b(do not wish|don't wish|do not want|don't want|prefer not|decline|choose not|not disclose|no answer|wish not)\b/i;

  function labelledText(node) {
    const id = node.getAttribute("id");
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrap = node.closest("label");
    const aria = node.getAttribute("aria-label");
    const labelledBy = clean(
      (node.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
    );

    return clean(byFor?.textContent || wrap?.textContent || aria || labelledBy || "");
  }

  function nearbyLabel(node) {
    const direct = labelledText(node);

    if (direct && !/^(yes|no|true|false|type your response|select)$/i.test(direct)) {
      return direct;
    }

    let cursor = node.parentElement;

    for (let depth = 0; cursor && depth < 7; depth++) {
      const legend = cursor.querySelector("legend");
      const label = cursor.querySelector("label, [class*='label'], [class*='question'], h1, h2, h3, h4, p");
      const text = clean(legend?.textContent || label?.textContent || cursor.textContent || "");
      const options = Array.from(cursor.querySelectorAll("input[type='radio'], input[type='checkbox']"))
        .map((item) => labelledText(item) || item.value)
        .filter(Boolean);
      let candidate = text;

      for (const option of options) {
        candidate = candidate.replace(new RegExp(option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
      }

      candidate = clean(candidate.replace(/[✱*]/g, " ").replace(/\b(Type your response|Select \.\.\.|Write here)\b/gi, " "));

      if (candidate.length > 2 && !/^(yes|no|true|false)$/i.test(candidate)) {
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

    return Array.from(document.querySelectorAll("input, textarea, select"))
      .map((node, index) => {
        const tag = node.tagName.toLowerCase();
        const type = tag === "input" ? String(node.type || "text").toLowerCase() : tag;

        if (["hidden", "button", "submit", "reset", "image"].includes(type)) {
          return null;
        }

        if (/captcha/i.test(`${node.name || ""} ${node.id || ""}`)) {
          return null;
        }

        const key = node.name || node.id || `field_${index}`;
        const groupKey = type === "radio" || type === "checkbox" ? `${type}:${key}` : "";

        if (groupKey && seen.has(groupKey)) {
          return null;
        }

        if (groupKey) {
          seen.add(groupKey);
        }

        const fieldId = `jm_${index}_${key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60)}`;
        node.dataset.jobmateFieldId = fieldId;

        return {
          node,
          field: {
            fieldId,
            key,
            label: nearbyLabel(node),
            type,
            required: node.required || /✱|\*|required/i.test(nearbyLabel(node)),
            options:
              tag === "select"
                ? Array.from(node.options).map((option) => clean(option.label || option.text || option.value)).filter(Boolean)
                : type === "radio" || type === "checkbox"
                  ? groupOptions(node, type)
                  : []
          }
        };
      })
      .filter(Boolean);
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
    const wanted = answer.split(/\n|,|;/).map(norm).filter(Boolean);

    for (const item of group) {
      const label = norm(`${labelledText(item)} ${item.value}`);
      const match = wanted.some((part) => label.includes(part) || part.includes(label));

      if (match || (!wanted.length && /^(yes|true)$/i.test(answer) && /yes|true/i.test(label))) {
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

  function base64ToFile(upload) {
    const binary = atob(upload.base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new File([bytes], upload.name, { type: upload.mimeType });
  }

  function attachFiles(fileInputs, payload) {
    const resume = payload.resumeUpload ? base64ToFile(payload.resumeUpload) : null;
    const cover = payload.coverUpload ? base64ToFile(payload.coverUpload) : null;

    fileInputs.forEach((input, index) => {
      const label = norm(nearbyLabel(input));
      const transfer = new DataTransfer();

      if (/cover/.test(label) && cover) {
        transfer.items.add(cover);
      } else if (/resume|cv/.test(label) && resume) {
        transfer.items.add(resume);
      } else if (index === 0 && resume) {
        transfer.items.add(resume);
        if (fileInputs.length === 1 && cover) transfer.items.add(cover);
      } else if (cover) {
        transfer.items.add(cover);
      }

      if (transfer.files.length) {
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  }

  async function fillControl(item, answer) {
    const node = item.node;
    const type = item.field.type;
    const tag = node.tagName.toLowerCase();

    if (!answer || type === "file") {
      return;
    }

    if (type === "radio" || type === "checkbox") {
      choose(node, answer, type === "checkbox");
    } else if (tag === "select") {
      const value = Array.from(node.options).find((option) => norm(option.label || option.text || option.value) === norm(answer));
      node.value = value?.value || answer;
      node.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      await typeText(node, answer);
    }

    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await sleep(60);
  }

  function panel(message) {
    let box = document.getElementById("jobmate-status");

    if (!box) {
      box = document.createElement("div");
      box.id = "jobmate-status";
      box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111827;color:white;padding:12px 14px;border-radius:8px;max-width:360px;font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.25)";
      document.body.appendChild(box);
    }

    box.textContent = message;
  }

  async function run() {
    panel("JobMate: loading payload...");
    const payload = await fetch(payloadUrl).then((res) => res.json());
    const fieldItems = controls();
    panel(`JobMate: read ${fieldItems.length} form fields; asking LLM...`);
    const answerUrl = payloadUrl.replace("/payload/", "/answers/");
    const answersPayload = await fetch(answerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: fieldItems.map((item) => item.field) })
    }).then((res) => res.json());
    const answers = new Map((answersPayload.answers || []).map((item) => [item.fieldId, item.answer || ""]));
    for (const item of fieldItems) {
      const current = answers.get(item.field.fieldId) || "";
      const optOut = optOutAnswer(item.field);

      if (optOut && (!current || !item.field.options.some((option) => norm(option) === norm(current)))) {
        answers.set(item.field.fieldId, optOut);
      }
    }
    payload.coverLetterText = answersPayload.coverLetterText || payload.coverLetterText || "";
    payload.coverUpload = answersPayload.coverUpload || payload.coverUpload || null;
    attachFiles(Array.from(document.querySelectorAll('input[type="file"]')), payload);

    for (let i = 0; i < fieldItems.length; i++) {
      const item = fieldItems[i];
      panel(`JobMate: typing ${i + 1}/${fieldItems.length}: ${item.field.label}`);
      await fillControl(item, answers.get(item.field.fieldId) || "");
    }

    await fetch(payloadUrl.replace("/payload/", "/complete/"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicationUrl: location.href })
    }).catch(() => {});
    panel("JobMate: fill pass complete. Review before submitting.");
  }

  run().catch((err) => panel(`JobMate error: ${err && err.message ? err.message : String(err)}`));
})();
