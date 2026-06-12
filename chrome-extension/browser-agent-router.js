const ROUTER_CLASSIFIER_ACTION_LIMIT = 120;
const ROUTER_CHEAP_MODEL = "gemini-3.1-flash-lite";
const ROUTER_STRONG_MODEL = "gemini-2.5-pro";

async function callGeminiRouter(apiKey, model, parts, json) {
  const resolvedModel = model || ROUTER_CHEAP_MODEL;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolvedModel)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: json ? { responseMimeType: "application/json" } : undefined
      }),
      signal: AbortSignal.timeout(90000)
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${resolvedModel}: ${res.status}${txt ? " " + txt.slice(0, 300) : ""}`);
  }
  const payload = await res.json();
  const text = payload.candidates?.flatMap((c) => c.content?.parts ?? []).map((p) => p.text ?? "").join("") ?? "";
  if (!text.trim()) throw new Error(`${resolvedModel}: empty response`);
  return text;
}

function routerResolveUrl(url, base) {
  try {
    return new URL(url, base).toString();
  } catch {
    return "";
  }
}

function routerPageHost(pageUrl) {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function routerIsApplicationFormPhase(fields) {
  return (
    fields.some((f) => f.fieldType === "file" || f.fieldType === "textarea" || f.fieldType === "contenteditable") ||
    fields.length >= 8
  );
}

function routerIsAuthOnlyFormPhase(fields) {
  if (!fields.length) return false;
  const hasPassword = fields.some((f) => f.fieldType === "password");
  return hasPassword && !routerIsApplicationFormPhase(fields);
}

function routerHistoryShowsAuthAttempts(history) {
  if (!Array.isArray(history)) return false;
  return history.some((item) => {
    const tool = String(item?.tool || "");
    return tool === "auth_fill" || tool === "auth_gate";
  });
}

function routerIsRegistrationGatePhase(fields, actions, history, blockedIds, availableApplyIds) {
  if (routerIsApplicationFormPhase(fields)) return false;
  if (availableApplyIds.length > 0) return false;
  const fieldCount = fields.length;
  const hasPassword = fields.some((f) => f.fieldType === "password");
  if (hasPassword && fieldCount < 8) return true;
  if (routerHistoryShowsAuthAttempts(history)) return true;
  if (routerIsStuck(history, blockedIds) && fieldCount >= 1 && fieldCount <= 8) {
    const hasEmail = fields.some((f) => f.fieldType === "email");
    if (hasEmail) return true;
  }
  return false;
}

function routerIsPreApplyNavigationPhase(fields, actions, history, blockedIds, availableApplyIds) {
  return !routerIsApplicationFormPhase(fields) && !routerIsRegistrationGatePhase(fields, actions, history, blockedIds, availableApplyIds);
}

function routerDetectPhase(fields, actions, history, blockedIds, availableApplyIds) {
  if (routerIsRegistrationGatePhase(fields, actions, history, blockedIds, availableApplyIds)) return "auth_gate";
  if (routerIsPreApplyNavigationPhase(fields, actions, history, blockedIds, availableApplyIds)) return "pre_apply";
  if (routerIsAuthOnlyFormPhase(fields)) return "auth_form";
  return "application_form";
}

function routerFormatActionsForClassifier(actions) {
  return actions
    .map((e) => {
      let line = `elementId="${e.elementId}" [${e.role || e.tag}] "${String(e.text || e.name || "").slice(0, 80)}"`;
      if (e.href || e.url) line += ` url="${String(e.href || e.url).slice(0, 120)}"`;
      return line;
    })
    .join("\n");
}

function routerOcrBlockCenter(block) {
  return {
    x: Math.round((block.x0 + block.x1) / 2),
    y: Math.round((block.y0 + block.y1) / 2)
  };
}

function routerFormatOcrBlocks(ocrBlocks) {
  return (ocrBlocks || [])
    .map((block, index) => {
      const center = routerOcrBlockCenter(block);
      return `${index}: "${String(block.text || "").slice(0, 80)}" box=[${block.x0},${block.y0},${block.x1},${block.y1}] center=[${center.x},${center.y}]`;
    })
    .join("\n");
}

function routerCoordsFromParsed(parsed, ocrBlocks) {
  const blockIndexRaw = parsed.blockIndex;
  if (blockIndexRaw !== null && blockIndexRaw !== undefined && blockIndexRaw !== "") {
    const blockIndex = Number(blockIndexRaw);
    if (Number.isFinite(blockIndex) && blockIndex >= 0 && blockIndex < (ocrBlocks || []).length) {
      const block = ocrBlocks[blockIndex];
      return { coords: routerOcrBlockCenter(block), ocrBlock: block };
    }
  }
  const coords = parsed.coords;
  if (coords && Number.isFinite(Number(coords.x)) && Number.isFinite(Number(coords.y))) {
    const x = Math.round(Number(coords.x));
    const y = Math.round(Number(coords.y));
    if (x >= 0 && x <= 1000 && y >= 0 && y <= 1000) {
      return { coords: { x, y }, ocrBlock: null };
    }
  }
  return null;
}

function routerCoordBlockKey(coords) {
  return `coord:${coords.x},${coords.y}`;
}

function routerValidateRankedActionIds(rawIds, actions, blockedIds, guardFail) {
  const actionById = new Map(actions.map((a) => [a.elementId, a]));
  const out = [];
  for (const id of rawIds) {
    const sid = String(id);
    if (blockedIds.has(sid)) continue;
    const action = actionById.get(sid);
    if (!action) continue;
    if (guardFail(action)) continue;
    if (!out.includes(sid)) out.push(sid);
  }
  return out;
}

function routerCompactHistory(history, limit) {
  return (history || []).slice(-limit).map((h) => {
    const out = { t: h.tool };
    if (h.elementId) out.el = h.elementId;
    if (h.url) out.url = h.url;
    if (h.reasoning) out.r = String(h.reasoning).slice(0, 60);
    return out;
  });
}

function routerBuildAllowedUrls(applyAnchorUrls, pageUrl, pageHost, targetApplyUrl, hiddenApplyUrl, leftListing) {
  const allowed = new Set();
  for (const candidate of applyAnchorUrls) {
    const resolved = routerResolveUrl(candidate, pageUrl);
    if (resolved && isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl, hiddenApplyUrl, leftListing)) {
      allowed.add(resolved);
    }
  }
  return allowed;
}

function routerAxActionGuardFail(picked, applyAnchorUrls, pageUrl, leftListing, targetApplyUrl) {
  if (!picked) return true;
  const href = picked.href || picked.url || "";
  if (!href) return false;
  if (isOffTargetJobUrl(href, applyAnchorUrls, pageUrl)) return true;
  if (leftListing && isReturnToListingUrl(href, targetApplyUrl, pageUrl)) return true;
  return false;
}

function routerIsAmbiguous(rankIds, deterministicCount) {
  if (rankIds.length > 1) return true;
  if (rankIds.length === 0 && deterministicCount === 0) return true;
  return false;
}

function routerIsStuck(history, blockedIds) {
  const recent = (history || []).slice(-4);
  const failedClicks = recent.filter((h) => h.tool === "click" || h.tool === "submit").length;
  return blockedIds.size >= 2 || failedClicks >= 2;
}

function buildPageObservation(input) {
  const {
    tabId,
    pageUrl,
    pageText,
    stepIndex,
    history,
    hiddenApplyUrl,
    elements,
    blockedElementIds,
    hasLeftTargetListing,
    targetApplyUrl,
    targetTitle,
    targetCompany,
    actions,
    allActions,
    networkObservations,
    ocrBlocks,
    viewport,
    ocrImageSize,
    captureSize
  } = input;

  const blockedIds = new Set(Array.isArray(blockedElementIds) ? blockedElementIds.map(String) : []);
  const fields = (elements || []).filter((e) => e.type === "field");
  const pageHost = routerPageHost(pageUrl);
  const leftListing = Boolean(hasLeftTargetListing);
  const applyAnchorUrls = [targetApplyUrl, hiddenApplyUrl].filter(Boolean);

  const axActionGuardFail = (picked) =>
    routerAxActionGuardFail(picked, applyAnchorUrls, pageUrl, leftListing, targetApplyUrl);

  const applyAdvancingIds = rankScopedApplyAdvancingActions(actions, applyAnchorUrls, pageUrl, axActionGuardFail);
  const availableApplyIds = applyAdvancingIds.filter((id) => !blockedIds.has(id));
  const phase = routerDetectPhase(fields, actions, history, blockedIds, availableApplyIds);

  const allowedUrls = routerBuildAllowedUrls(
    applyAnchorUrls,
    pageUrl,
    pageHost,
    targetApplyUrl,
    hiddenApplyUrl,
    leftListing
  );

  return {
    tabId,
    pageUrl,
    pageText: String(pageText || ""),
    pageHost,
    stepIndex,
    phase,
    preApplyPhase: phase === "pre_apply",
    authGatePhase: phase === "auth_gate",
    targetApplyUrl,
    targetTitle,
    targetCompany,
    hiddenApplyUrl: hiddenApplyUrl || null,
    leftListing,
    fields,
    actions,
    allActions: allActions || actions,
    blockedIds,
    history: history || [],
    allowedUrls,
    applyAnchorUrls,
    networkObservations: networkObservations || [],
    ocrBlocks: ocrBlocks || [],
    viewport: viewport || null,
    ocrImageSize: ocrImageSize || null,
    captureSize: captureSize || null,
    axActionGuardFail,
    ambiguous: false,
    stuck: routerIsStuck(history, blockedIds)
  };
}

function buildDeterministicCandidates(observation) {
  const { phase, actions, applyAnchorUrls, pageUrl, axActionGuardFail, allowedUrls } = observation;

  if (phase === "pre_apply") {
    const applyAdvancingIds = rankScopedApplyAdvancingActions(actions, applyAnchorUrls, pageUrl, axActionGuardFail);
    const navigateUrls = [];
    for (const candidate of allowedUrls) {
      if (normalizeApplyPageUrl(candidate) !== normalizeApplyPageUrl(pageUrl)) {
        navigateUrls.push(candidate);
      }
    }
    return {
      applyAdvancingIds,
      formAdvancingIds: [],
      navigateUrls,
      rankedIds: applyAdvancingIds
    };
  }

  return {
    applyAdvancingIds: [],
    formAdvancingIds: [],
    navigateUrls: [...allowedUrls],
    rankedIds: []
  };
}

async function rankCandidatesWithCheapModel(apiKey, model, observation, candidates, rankKind) {
  const {
    actions,
    pageUrl,
    targetApplyUrl,
    targetTitle,
    targetCompany,
    hiddenApplyUrl,
    history,
    blockedIds,
    axActionGuardFail,
    applyAnchorUrls,
    fields,
    ocrBlocks
  } = observation;

  const ocrText = routerFormatOcrBlocks(ocrBlocks);

  const classifierActions = prioritizeActionsForClassifier(
    actions,
    applyAnchorUrls,
    pageUrl,
    ROUTER_CLASSIFIER_ACTION_LIMIT
  );

  const compactHistory = routerCompactHistory(history, 3);
  const actionsText = routerFormatActionsForClassifier(classifierActions);

  let prompt;
  let resultKey;

  if (rankKind === "apply") {
    resultKey = "applyAdvancing";
    prompt = [
      "Rank interactive controls that advance the user's application to the target job they selected.",
      'Return exactly: {"applyAdvancing":["elementId",...],"reasoning":""}',
      "Order best-first. Only use elementIds from INTERACTIVE ELEMENTS.",
      "Buttons and links without URLs that start the application on this page must be ranked.",
      "The primary apply control on the page should be ranked first.",
      targetTitle ? `Target job: "${targetTitle}" at ${targetCompany}` : "Target: the job the user chose to apply to",
      `Target URL: ${targetApplyUrl}`,
      hiddenApplyUrl ? `Hidden apply URL: ${hiddenApplyUrl}` : "",
      `Current page: ${pageUrl}`,
      compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
      ocrText ? `OCR_BLOCKS (normalized 0-1000):\n${ocrText}` : "",
      actionsText ? `INTERACTIVE ELEMENTS:\n${actionsText}` : ""
    ];
  } else {
    resultKey = "formAdvancing";
    prompt = [
      "Rank interactive controls that advance the current application form step for the target job the user selected.",
      'Return exactly: {"formAdvancing":["elementId",...],"reasoning":""}',
      "Order best-first. Only use elementIds from INTERACTIVE ELEMENTS.",
      targetTitle ? `Target job: "${targetTitle}" at ${targetCompany}` : "Target: the job the user chose to apply to",
      `Target URL: ${targetApplyUrl}`,
      `Current page: ${pageUrl}`,
      `Visible form fields: ${fields.length}`,
      compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
      ocrText ? `OCR_BLOCKS (normalized 0-1000):\n${ocrText}` : "",
      actionsText ? `INTERACTIVE ELEMENTS:\n${actionsText}` : ""
    ];
  }

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt.filter(Boolean).join("\n\n") }], true);
  const parsed = parseJsonObjectExt(raw);
  const rawIds = Array.isArray(parsed[resultKey]) ? parsed[resultKey].map(String) : [];
  const ranked = routerValidateRankedActionIds(rawIds, actions, blockedIds, axActionGuardFail);

  let scopeActions = actions;
  if (rankKind === "apply" && candidates.applyAdvancingIds.length > 1) {
    const scope = new Set(candidates.applyAdvancingIds);
    scopeActions = actions.filter((a) => scope.has(a.elementId));
    if (scopeActions.length) {
      const scopedText = routerFormatActionsForClassifier(
        prioritizeActionsForClassifier(scopeActions, applyAnchorUrls, pageUrl, ROUTER_CLASSIFIER_ACTION_LIMIT)
      );
      const scopedPrompt = [
        ...prompt.slice(0, -1),
        `INTERACTIVE ELEMENTS:\n${scopedText}`
      ];
      const scopedRaw = await callGeminiRouter(apiKey, model, [{ text: scopedPrompt.filter(Boolean).join("\n\n") }], true);
      const scopedParsed = parseJsonObjectExt(scopedRaw);
      const scopedIds = Array.isArray(scopedParsed[resultKey]) ? scopedParsed[resultKey].map(String) : [];
      const scopedRanked = routerValidateRankedActionIds(scopedIds, scopeActions, blockedIds, axActionGuardFail);
      if (scopedRanked.length) {
        return { rankedIds: scopedRanked, reasoning: String(scopedParsed.reasoning ?? "") };
      }
    }
  }

  if (rankKind === "apply" && candidates.applyAdvancingIds.length === 1) {
    return { rankedIds: candidates.applyAdvancingIds, reasoning: "Same-job-scope apply link." };
  }

  return { rankedIds: ranked, reasoning: String(parsed.reasoning ?? "") };
}

async function rankAuthGateActionsWithCheapModel(apiKey, model, observation) {
  const {
    actions,
    pageUrl,
    targetApplyUrl,
    targetTitle,
    targetCompany,
    history,
    blockedIds,
    axActionGuardFail,
    ocrBlocks
  } = observation;

  const actionsText = routerFormatActionsForClassifier((actions || []).slice(0, ROUTER_CLASSIFIER_ACTION_LIMIT));
  const ocrText = routerFormatOcrBlocks(ocrBlocks);
  const compactHistory = routerCompactHistory(history, 5);
  const prompt = [
    "Rank interactive controls to pass an authentication gate before the job application can continue.",
    'Return exactly: {"authGate":["elementId",...],"reasoning":""}',
    "Order best-first. Only use elementIds from INTERACTIVE ELEMENTS.",
    "Prefer sign-in and log-in controls first so existing credentials can be used.",
    "Only rank account-creation and registration controls when every sign-in and log-in control is unavailable or already tried.",
    targetTitle ? `Target job: "${targetTitle}" at ${targetCompany}` : "Target: the job the user chose to apply to",
    `Target URL: ${targetApplyUrl}`,
    `Current page: ${pageUrl}`,
    compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
    blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
    ocrText ? `OCR_BLOCKS (normalized 0-1000):\n${ocrText}` : "",
    actionsText ? `INTERACTIVE ELEMENTS:\n${actionsText}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const rawIds = Array.isArray(parsed.authGate) ? parsed.authGate.map(String) : [];
  const ranked = routerValidateRankedActionIds(rawIds, actions, blockedIds, axActionGuardFail);
  return { rankedIds: ranked, reasoning: String(parsed.reasoning ?? "") };
}

async function resolveOcrAuthGateClick(apiKey, model, observation, rankReasoning) {
  const { ocrBlocks, blockedIds, pageUrl, targetApplyUrl, targetTitle, targetCompany, history, fields } = observation;
  if (!ocrBlocks.length) return null;

  const ocrText = routerFormatOcrBlocks(ocrBlocks);
  const compactHistory = routerCompactHistory(history, 5);
  const prompt = [
    "You are on an authentication gate before a job application can continue.",
    "Choose the OCR text block for sign-in or log-in first.",
    "Only choose account-creation or registration when every sign-in and log-in option is unavailable or already tried.",
    "Do not choose portal navigation, headers, or field labels.",
    'Return exactly: {"blockIndex":null,"reasoning":""}',
    "Pick blockIndex from OCR_BLOCKS. The click happens at the center of that box.",
    targetTitle ? `Target job: "${targetTitle}" at ${targetCompany}` : "Target: the job the user chose to apply to",
    `Target URL: ${targetApplyUrl}`,
    `Current page: ${pageUrl}`,
    fields.length ? `Visible fields on page: ${fields.length}` : "",
    compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
    rankReasoning ? `Prior reasoning: ${rankReasoning}` : "",
    blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
    `OCR_BLOCKS:\n${ocrText}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const picked = routerCoordsFromParsed(parsed, ocrBlocks);
  if (!picked) return null;
  const coordKey = routerCoordBlockKey(picked.coords);
  if (blockedIds.has(coordKey)) return null;

  return {
    tool: "click",
    elementId: null,
    url: null,
    coords: picked.coords,
    ocrBlock: picked.ocrBlock,
    text: null,
    value: null,
    reasoning: String(parsed.reasoning ?? ""),
    coverLetterElementIds: [],
    coverLetterRevealIds: [],
    resumeElementIds: []
  };
}

async function tryOcrAuthGateClick(apiKey, model, observation, rankReasoning, rankedIds) {
  const ocrClick = await resolveOcrAuthGateClick(apiKey, model, observation, rankReasoning);
  if (!ocrClick) return null;
  const validated = validateBrowserAction(observation, ocrClick, rankedIds);
  return validated.tool !== "blocked" ? validated : null;
}

async function recoverWithStrongModel(apiKey, observation, candidates, rankedIds, rankReasoning) {
  const {
    pageUrl,
    pageText,
    stepIndex,
    targetApplyUrl,
    targetTitle,
    targetCompany,
    leftListing,
    blockedIds,
    history,
    allowedUrls,
    fields,
    actions,
    axActionGuardFail,
    allActions,
    networkObservations,
    ocrBlocks
  } = observation;

  const ocrText = routerFormatOcrBlocks(ocrBlocks);
  const compactHistory = routerCompactHistory(history, 5);
  const networkText = (networkObservations || [])
    .slice(0, 12)
    .map((n) => `${n.method} ${n.url} status=${n.status ?? "pending"} type=${n.resourceType || ""}`)
    .join("\n");

  const prompt = (ocrBlocks.length
    ? [
        observation.phase === "auth_gate"
          ? "Choose the OCR text block for sign-in or log-in. Only choose account-creation or registration when sign-in is unavailable or already tried."
          : observation.phase === "pre_apply"
            ? "Choose the OCR text block to click to start or advance the job application."
            : "Choose the OCR text block to click to advance the current application form step.",
        'Return exactly: {"tool":"click|navigate|wait|blocked","blockIndex":null,"url":null,"reasoning":""}',
        "Pick blockIndex from OCR_BLOCKS. The click happens at the center of that box.",
        "Do not reference DOM elements or elementIds.",
        leftListing ? "Do not navigate back to the listing page." : "",
        targetTitle ? `Job: "${targetTitle}" at ${targetCompany}` : "Target: apply on this page",
        `Target URL: ${targetApplyUrl}`,
        `Current: ${pageUrl} (step ${stepIndex})`,
        blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
        compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
        allowedUrls.size ? `Allowed navigate URLs: ${JSON.stringify([...allowedUrls])}` : "",
        networkText ? `Recent network:\n${networkText}` : "",
        `OCR_BLOCKS:\n${ocrText}`
      ]
    : [
        observation.phase === "auth_gate"
          ? "You are choosing the control that passes the authentication gate. Prefer sign-in and log-in. Only choose account-creation or registration when sign-in is unavailable or already tried."
          : observation.phase === "pre_apply"
            ? "You are choosing the control that starts or advances the job application for the target job."
            : "You are recovering a stuck job application browser step.",
        "Choose ONE action that advances the current step toward submission.",
        'Return exactly: {"tool":"click|submit|navigate|wait|blocked","elementId":null,"url":null,"reasoning":""}',
        leftListing ? "Do not navigate back to the listing page." : "",
        targetTitle ? `Job: "${targetTitle}" at ${targetCompany}` : "Target: apply on this page",
        `Target URL: ${targetApplyUrl}`,
        `Current: ${pageUrl} (step ${stepIndex})`,
        blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
        compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
        allowedUrls.size ? `Allowed navigate URLs: ${JSON.stringify([...allowedUrls])}` : "",
        `Form with ${fields.length} fields is present. Extension fills fields automatically.`,
        rankReasoning ? `Prior rank reasoning: ${rankReasoning}` : "",
        networkText ? `Recent network:\n${networkText}` : "",
        `PAGE TEXT:\n${pageText.slice(0, 1500)}`
      ])
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, ROUTER_STRONG_MODEL, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);

  const toolRaw = String(parsed.tool ?? "");
  const validTools = ["navigate", "click", "submit", "wait", "blocked"];
  const tool = validTools.includes(toolRaw) ? toolRaw : "blocked";

  const coordsPick = routerCoordsFromParsed(parsed, ocrBlocks);
  if (coordsPick) {
    const coordKey = routerCoordBlockKey(coordsPick.coords);
    if (blockedIds.has(coordKey)) {
      return {
        tool: "blocked",
        elementId: null,
        url: null,
        coords: null,
        ocrBlock: null,
        text: null,
        value: null,
        reasoning: "OCR coordinate already tried.",
        coverLetterElementIds: [],
        coverLetterRevealIds: [],
        resumeElementIds: []
      };
    }
    return {
      tool: "click",
      elementId: null,
      url: null,
      coords: coordsPick.coords,
      ocrBlock: coordsPick.ocrBlock,
      text: null,
      value: null,
      reasoning: String(parsed.reasoning ?? rankReasoning ?? ""),
      coverLetterElementIds: [],
      coverLetterRevealIds: [],
      resumeElementIds: []
    };
  }

  const clickValidIds = rankedIds.length
    ? new Set([...rankedIds, ...fields.map((e) => e.elementId)])
    : new Set([...actions.map((e) => e.elementId), ...fields.map((e) => e.elementId)]);

  const elementIdRaw = parsed.elementId ? String(parsed.elementId) : "";
  let elementId = clickValidIds.has(elementIdRaw) ? elementIdRaw : null;
  if (elementId) {
    const picked = allActions.find((e) => e.elementId === elementId);
    if (blockedIds.has(elementId) || axActionGuardFail(picked)) {
      elementId = null;
    }
  }

  const urlRaw = parsed.url ? routerResolveUrl(String(parsed.url), pageUrl) : "";
  let url =
    urlRaw && allowedUrls.has(urlRaw) && isAllowedNavigateUrl(urlRaw, pageUrl, observation.pageHost, targetApplyUrl, observation.hiddenApplyUrl, leftListing)
      ? urlRaw
      : null;

  let resolvedTool =
    tool === "navigate" && !url && elementId
      ? "click"
      : (tool === "click" || tool === "submit") && !elementId && url
        ? "navigate"
        : tool;

  if (rankedIds.length && observation.phase !== "pre_apply") {
    if (resolvedTool !== "click" && resolvedTool !== "submit") {
      resolvedTool = "click";
      elementId = rankedIds[0];
      url = null;
    } else if (!elementId || !rankedIds.includes(elementId)) {
      elementId = rankedIds[0];
      resolvedTool = "click";
      url = null;
    }
  }

  if (resolvedTool === "click" && !elementId && !coords) resolvedTool = "blocked";
  if (resolvedTool === "navigate" && !url) resolvedTool = "blocked";

  return {
    tool: resolvedTool,
    elementId,
    url,
    coords: null,
    text: null,
    value: null,
    reasoning: String(parsed.reasoning ?? rankReasoning ?? ""),
    coverLetterElementIds: [],
    coverLetterRevealIds: [],
    resumeElementIds: []
  };
}

async function resolveOcrApplyClick(apiKey, model, observation, rankReasoning) {
  const { ocrBlocks, blockedIds, pageUrl, targetApplyUrl, targetTitle, targetCompany, history, phase, fields } = observation;
  if (!ocrBlocks.length) return null;

  const ocrText = routerFormatOcrBlocks(ocrBlocks);
  const compactHistory = routerCompactHistory(history, 3);
  const fileFieldLabels = fields
    .filter((field) => field.fieldType === "file")
    .map((field) => String(field.label || field.text || "").trim())
    .filter(Boolean);
  const prompt = [
    phase === "pre_apply"
      ? "Choose the OCR text block to click to start or advance the job application."
      : "Choose the OCR text block to click to advance the current application form step.",
    'Return exactly: {"blockIndex":null,"reasoning":""}',
    "Pick blockIndex from OCR_BLOCKS. The click happens at the center of that box.",
    "Do not pick OCR blocks for file attachment or resume upload controls.",
    fileFieldLabels.length ? `File upload field labels on this page: ${fileFieldLabels.join("; ")}` : "",
    targetTitle ? `Target job: "${targetTitle}" at ${targetCompany}` : "Target: the job the user chose to apply to",
    `Target URL: ${targetApplyUrl}`,
    `Current page: ${pageUrl}`,
    compactHistory.length ? `Recent actions: ${JSON.stringify(compactHistory)}` : "",
    rankReasoning ? `Prior reasoning: ${rankReasoning}` : "",
    blockedIds.size ? `Skip these (already tried): ${[...blockedIds].join(", ")}` : "",
    `OCR_BLOCKS:\n${ocrText}`
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await callGeminiRouter(apiKey, model, [{ text: prompt }], true);
  const parsed = parseJsonObjectExt(raw);
  const picked = routerCoordsFromParsed(parsed, ocrBlocks);
  if (!picked) return null;
  const coordKey = routerCoordBlockKey(picked.coords);
  if (blockedIds.has(coordKey)) return null;

  return {
    tool: "click",
    elementId: null,
    url: null,
    coords: picked.coords,
    ocrBlock: picked.ocrBlock,
    text: null,
    value: null,
    reasoning: String(parsed.reasoning ?? ""),
    coverLetterElementIds: [],
    coverLetterRevealIds: [],
    resumeElementIds: []
  };
}

async function tryOcrCoordinateClick(apiKey, model, observation, rankReasoning, rankedIds) {
  const ocrClick = await resolveOcrApplyClick(apiKey, model, observation, rankReasoning);
  if (!ocrClick) return null;
  const validated = validateBrowserAction(observation, ocrClick, rankedIds);
  return validated.tool !== "blocked" ? validated : null;
}

function validateBrowserAction(observation, action, rankedIds) {
  const { allActions, blockedIds, axActionGuardFail, allowedUrls, pageUrl, pageHost, targetApplyUrl, hiddenApplyUrl, leftListing, phase } =
    observation;

  if (!action || !action.tool) {
    return { tool: "blocked", elementId: null, url: null, reasoning: "No action produced.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
  }

  if (action.tool === "navigate") {
    const resolved = action.url ? routerResolveUrl(action.url, pageUrl) : "";
    if (
      !resolved ||
      !allowedUrls.has(resolved) ||
      !isAllowedNavigateUrl(resolved, pageUrl, pageHost, targetApplyUrl, hiddenApplyUrl, leftListing)
    ) {
      return { tool: "blocked", elementId: null, url: null, reasoning: "Navigation target not allowed.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
    }
    if (phase === "pre_apply" && normalizeApplyPageUrl(resolved) === normalizeApplyPageUrl(pageUrl)) {
      return { tool: "blocked", elementId: null, url: null, reasoning: "Navigation would not change page.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
    }
    return { ...action, url: resolved };
  }

  if (action.tool === "click" || action.tool === "submit") {
    if (action.coords && Number.isFinite(Number(action.coords.x)) && Number.isFinite(Number(action.coords.y))) {
      const x = Math.round(Number(action.coords.x));
      const y = Math.round(Number(action.coords.y));
      if (x < 0 || x > 1000 || y < 0 || y > 1000) {
        return { tool: "blocked", elementId: null, url: null, coords: null, reasoning: "OCR coordinates out of range.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
      }
      const coordKey = routerCoordBlockKey({ x, y });
      if (blockedIds.has(coordKey)) {
        return { tool: "blocked", elementId: null, url: null, coords: null, reasoning: "OCR coordinate already tried.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
      }
      return { ...action, elementId: null, coords: { x, y }, ocrBlock: action.ocrBlock || null };
    }
    const elementId = action.elementId ? String(action.elementId) : "";
    if (!elementId) {
      return { tool: "blocked", elementId: null, url: null, reasoning: "Click action missing element.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
    }
    const picked = allActions.find((e) => e.elementId === elementId);
    if (blockedIds.has(elementId) || axActionGuardFail(picked)) {
      return { tool: "blocked", elementId: null, url: null, reasoning: "Element blocked or off-target.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
    }
    if (rankedIds.length && phase !== "pre_apply" && !rankedIds.includes(elementId)) {
      return { tool: "blocked", elementId: null, url: null, reasoning: "Element not in ranked candidates.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] };
    }
    const stemChildUrl = picked ? resolveStemChildActionUrl(picked, observation.applyAnchorUrls, pageUrl) : "";
    return { ...action, elementId, url: stemChildUrl || action.url || null };
  }

  return action;
}

function packRouterAnalyzeResponse(observation, action, rankedIds) {
  const viewportWidth = Number(observation.viewport?.width);
  const viewportHeight = Number(observation.viewport?.height);
  const scrollX = Number(observation.viewport?.scrollX);
  const scrollY = Number(observation.viewport?.scrollY);
  const captureWidth = Number(observation.captureSize?.width);
  const captureHeight = Number(observation.captureSize?.height);
  return {
    ok: true,
    action,
    clickLayout: {
      viewportWidth: Number.isFinite(viewportWidth) ? viewportWidth : 0,
      viewportHeight: Number.isFinite(viewportHeight) ? viewportHeight : 0,
      scrollX: Number.isFinite(scrollX) ? scrollX : 0,
      scrollY: Number.isFinite(scrollY) ? scrollY : 0,
      captureWidth: Number.isFinite(captureWidth) ? captureWidth : 0,
      captureHeight: Number.isFinite(captureHeight) ? captureHeight : 0
    },
    interactiveActions: observation.actions.map((a) => ({
      elementId: a.elementId,
      role: a.role,
      name: a.name,
      text: a.text,
      url: a.url || a.href || "",
      href: a.href || a.url || "",
      backendNodeId: a.backendNodeId
    })),
    applyAdvancingIds: rankedIds,
    preApplyPhase: observation.preApplyPhase,
    authGatePhase: observation.authGatePhase
  };
}

async function routeBrowserAction(apiKey, cheapModel, observation, semanticMemoryResolve) {
  const candidates = buildDeterministicCandidates(observation);
  let rankedIds = candidates.rankedIds;
  let rankReasoning = "";
  const rankKind = observation.phase === "pre_apply" ? "apply" : "form";

  if (observation.phase === "application_form") {
    const ranked = await rankCandidatesWithCheapModel(apiKey, cheapModel, observation, candidates, rankKind);
    rankedIds = ranked.rankedIds;
    rankReasoning = ranked.reasoning;
  }

  observation.ambiguous = routerIsAmbiguous(rankedIds, candidates.applyAdvancingIds.length);

  if (observation.phase === "auth_gate") {
    const authRanked = await rankAuthGateActionsWithCheapModel(apiKey, cheapModel, observation);
    rankedIds = authRanked.rankedIds;
    rankReasoning = authRanked.reasoning;

    if (authRanked.rankedIds[0]) {
      const validated = validateBrowserAction(
        observation,
        {
          tool: "click",
          elementId: authRanked.rankedIds[0],
          url: null,
          text: null,
          value: null,
          reasoning: authRanked.reasoning || "Account registration control.",
          coverLetterElementIds: [],
          coverLetterRevealIds: [],
          resumeElementIds: []
        },
        authRanked.rankedIds
      );
      if (validated.tool !== "blocked") {
        return packRouterAnalyzeResponse(observation, validated, authRanked.rankedIds);
      }
    }

    const ocrClick = await tryOcrAuthGateClick(apiKey, cheapModel, observation, rankReasoning, authRanked.rankedIds);
    if (ocrClick) {
      return packRouterAnalyzeResponse(observation, ocrClick, authRanked.rankedIds);
    }

    if (observation.stuck) {
      const recovered = await recoverWithStrongModel(apiKey, observation, candidates, authRanked.rankedIds, rankReasoning);
      const validated = validateBrowserAction(observation, recovered, authRanked.rankedIds);
      return packRouterAnalyzeResponse(observation, validated, authRanked.rankedIds);
    }

    return packRouterAnalyzeResponse(
      observation,
      {
        tool: "blocked",
        elementId: null,
        url: null,
        text: null,
        value: null,
        reasoning: "No account-registration control found.",
        coverLetterElementIds: [],
        coverLetterRevealIds: [],
        resumeElementIds: []
      },
      authRanked.rankedIds
    );
  }

  if (observation.phase === "pre_apply") {
    const ocrClick = await tryOcrCoordinateClick(apiKey, cheapModel, observation, rankReasoning, rankedIds);
    if (ocrClick) {
      return packRouterAnalyzeResponse(observation, ocrClick, rankedIds);
    }
    for (const candidate of candidates.navigateUrls) {
      const validated = validateBrowserAction(
        observation,
        { tool: "navigate", elementId: null, url: candidate, text: null, value: null, reasoning: "Navigate to target job apply URL.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] },
        rankedIds
      );
      if (validated.tool !== "blocked") {
        return packRouterAnalyzeResponse(observation, validated, rankedIds);
      }
    }
    return packRouterAnalyzeResponse(
      observation,
      { tool: "blocked", elementId: null, url: null, text: null, value: null, reasoning: "No apply-advancing OCR target found.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] },
      rankedIds
    );
  }

  if (semanticMemoryResolve) {
    const memoryAction = await semanticMemoryResolve(observation, rankedIds);
    if (memoryAction) {
      const validated = validateBrowserAction(observation, memoryAction, rankedIds);
      if (validated.tool !== "blocked") {
        return packRouterAnalyzeResponse(observation, validated, rankedIds);
      }
    }
  }

  const ocrClick = await tryOcrCoordinateClick(apiKey, cheapModel, observation, rankReasoning, rankedIds);
  if (ocrClick) {
    return packRouterAnalyzeResponse(observation, ocrClick, rankedIds);
  }

  if (observation.ambiguous || observation.stuck) {
    const recovered = await recoverWithStrongModel(apiKey, observation, candidates, rankedIds, rankReasoning);
    const validated = validateBrowserAction(observation, recovered, rankedIds);
    return packRouterAnalyzeResponse(observation, validated, rankedIds);
  }

  if (rankedIds[0]) {
    const validated = validateBrowserAction(
      observation,
      { tool: "click", elementId: rankedIds[0], url: null, text: null, value: null, reasoning: rankReasoning || "Form-advancing control.", coverLetterElementIds: [], coverLetterRevealIds: [], resumeElementIds: [] },
      rankedIds
    );
    if (validated.tool !== "blocked") {
      return packRouterAnalyzeResponse(observation, validated, rankedIds);
    }
  }

  const recovered = await recoverWithStrongModel(apiKey, observation, candidates, rankedIds, rankReasoning);
  const validated = validateBrowserAction(observation, recovered, rankedIds);
  return packRouterAnalyzeResponse(observation, validated, rankedIds);
}
