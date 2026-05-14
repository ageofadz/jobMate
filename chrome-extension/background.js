function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitTabComplete(tabId, ms = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Google tab load timeout"));
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

async function runGoogleBatch(queryList, limitPerQuery) {
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const byQuery = {};

  try {
    for (const query of queryList) {
      byQuery[query] = await scrapeQueryAllPages(tab.id, query, limitPerQuery);
    }
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }

  return byQuery;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

  return false;
});
