import * as cheerio from "cheerio";

function withTimeout(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  return { controller, done: () => clearTimeout(timer) };
}

function candidateAboutUrls(homepage: string) {
  const urls: string[] = [];

  try {
    const root = new URL(homepage);
    urls.push(root.toString());

    if (!/\/about\/?$/i.test(root.pathname)) {
      urls.push(new URL("/about", root).toString());
      urls.push(new URL("/company", root).toString());
    }
  } catch {
    return [];
  }

  return [...new Set(urls)];
}

async function fetchReadableText(url: string) {
  const timeout = withTimeout(8000);

  try {
    const response = await fetch(url, {
      signal: timeout.controller.signal,
      headers: {
        "user-agent": "JobMateBot/0.1"
      }
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok || (contentType && !/text\/html|application\/xhtml/i.test(contentType))) {
      return "";
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, svg, nav, footer, form").remove();
    const text =
      $("main").text().replace(/\s+/g, " ").trim() ||
      $("article").text().replace(/\s+/g, " ").trim() ||
      $("body").text().replace(/\s+/g, " ").trim();

    return text.slice(0, 5000);
  } catch {
    return "";
  } finally {
    timeout.done();
  }
}

export async function fetchCompanyAboutContext(homepage: string | null | undefined) {
  if (!homepage) {
    return "";
  }

  const chunks: string[] = [];

  for (const url of candidateAboutUrls(homepage).slice(0, 3)) {
    const text = await fetchReadableText(url);

    if (text) {
      chunks.push(`Source: ${url}\n${text}`);
    }

    if (chunks.join("\n\n").length >= 5000) {
      break;
    }
  }

  return chunks.join("\n\n").slice(0, 7000);
}
