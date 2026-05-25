import http from "node:http";

import { ensureChromeApplyCoverLetter } from "@/lib/services/apply-cover-letter";
import { nextBrowserAction, generateFormAnswers, type PageElement } from "@/lib/services/llm";

type ServedUpload = {
  name: string;
  mimeType: string;
  base64: string;
};

export type ChromeApplyPayload = {
  id: string;
  jobId: string;
  title: string;
  company: string;
  companyHomepage: string;
  applyUrl: string;
  contextBlock: string;
  listingText: string;
  resumeText: string;
  writingSample: string;
  coverLetterTemplate: string;
  coverLetterText: string;
  candidateEmail: string;
  candidateFullName: string;
  resumeUpload: ServedUpload | null;
  coverUpload: ServedUpload | null;
  linkedinLinks: string[];
  hiringContacts: string[];
  answerPageHtml: string;
};

type LiveField = {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

type ApplyCompleteInfo = {
  applicationUrl?: string;
};

type Entry = {
  payload: ChromeApplyPayload;
  answers: Array<{ fieldId: string; answer: string; reasoning: string }>;
  completed: boolean;
  onComplete?: (info?: ApplyCompleteInfo) => void;
};

let server: http.Server | null = null;
let origin = "";
const entries = new Map<string, Entry>();

function json(res: http.ServerResponse, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function html(res: http.ServerResponse, code: number, body: string) {
  res.writeHead(code, {
    "access-control-allow-origin": "*",
    "access-control-allow-private-network": "true",
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function publicPayload(entry: Entry) {
  const {
    contextBlock: _context,
    listingText: _listing,
    resumeText: _resume,
    writingSample: _sample,
    coverLetterTemplate: _template,
    ...safe
  } = entry.payload;
  return safe;
}

async function ensureCoverLetter(entry: Entry, fields: LiveField[]) {
  await ensureChromeApplyCoverLetter(entry.payload, fields);
}

async function handleAnalyze(entry: Entry, req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await readJson(req)) as {
    pageUrl?: string;
    pageText?: string;
    stepIndex?: number;
    history?: Array<{ step: number; tool: string; reasoning?: string; elementId?: string | null; url?: string | null }>;
    hiddenApplyUrl?: string | null;
    elements?: PageElement[];
  };

  const browserAction = await nextBrowserAction({
    pageUrl: typeof body.pageUrl === "string" ? body.pageUrl : "",
    pageText: typeof body.pageText === "string" ? body.pageText : "",
    stepIndex: typeof body.stepIndex === "number" ? body.stepIndex : 0,
    history: Array.isArray(body.history) ? body.history : [],
    targetApplyUrl: entry.payload.applyUrl,
    targetTitle: entry.payload.title,
    targetCompany: entry.payload.company,
    candidateEmail: entry.payload.candidateEmail,
    hiddenApplyUrl: typeof body.hiddenApplyUrl === "string" ? body.hiddenApplyUrl : null,
    listingText: entry.payload.listingText,
    elements: Array.isArray(body.elements) ? body.elements : []
  });

  json(res, 200, browserAction);
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  const [, route, id] = url.pathname.split("/");
  const entry = id ? entries.get(id) : undefined;

  if (!entry) {
    json(res, 404, { error: "Unknown JobMate payload." });
    return;
  }

  if (route === "payload" && req.method === "GET") {
    json(res, 200, publicPayload(entry));
    return;
  }

  if (route === "answers" && req.method === "GET") {
    json(res, 200, {
      answers: entry.answers,
      completed: entry.completed,
      coverLetterText: entry.payload.coverLetterText,
      coverUpload: entry.payload.coverUpload
    });
    return;
  }

  if (route === "answers" && req.method === "POST") {
    const body = (await readJson(req)) as { fields?: LiveField[] };
    const fields = body.fields ?? [];
    await ensureCoverLetter(entry, fields);
    const resumePdf = entry.payload.resumeUpload?.base64
      ? Buffer.from(entry.payload.resumeUpload.base64, "base64")
      : null;
    const answers = await generateFormAnswers({
      contextBlock: entry.payload.contextBlock,
      listingText: entry.payload.listingText,
      fields,
      resumeText: resumePdf ? undefined : entry.payload.resumeText,
      resumePdf,
      coverLetterText: entry.payload.coverLetterText,
      writingSample: entry.payload.writingSample
    });

    entry.answers = fields.map((field) => ({
      fieldId: field.fieldId,
      answer: answers.get(field.fieldId)?.answer ?? "",
      reasoning: answers.get(field.fieldId)?.reasoning ?? "No answer returned."
    }));
    json(res, 200, {
      answers: entry.answers,
      coverLetterText: entry.payload.coverLetterText,
      coverUpload: entry.payload.coverUpload
    });
    return;
  }

  if (route === "analyze" && req.method === "POST") {
    await handleAnalyze(entry, req, res);
    return;
  }

  if (route === "complete" && req.method === "POST") {
    const body = (await readJson(req)) as { applicationUrl?: string };
    entry.completed = true;
    entry.onComplete?.(
      typeof body.applicationUrl === "string" && body.applicationUrl.trim()
        ? { applicationUrl: body.applicationUrl.trim() }
        : undefined
    );
    json(res, 200, { ok: true });
    return;
  }

  if (route === "page" && req.method === "GET") {
    html(res, 200, entry.payload.answerPageHtml);
    return;
  }

  json(res, 404, { error: "Unknown route." });
}

export async function ensureChromeApplyPayloadServer() {
  if (server && origin) {
    return origin;
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Unable to start JobMate Chrome extension payload server.");
  }

  origin = `http://127.0.0.1:${address.port}`;
  return origin;
}

export async function registerChromeApplyPayload(
  payload: ChromeApplyPayload,
  onComplete?: (info?: ApplyCompleteInfo) => void
) {
  const base = await ensureChromeApplyPayloadServer();
  entries.set(payload.id, {
    payload,
    answers: [],
    completed: false,
    onComplete
  });

  return {
    payloadUrl: `${base}/payload/${payload.id}`,
    answersUrl: `${base}/answers/${payload.id}`,
    completeUrl: `${base}/complete/${payload.id}`,
    answerPageUrl: `${base}/page/${payload.id}`
  };
}
