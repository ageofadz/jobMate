function safeDownloadFilename(filename) {
  const raw = String(filename || "_jobmate_resume.pdf");
  let safe = "";
  for (const char of raw) {
    safe += char === "/" || char === "\\" ? "_" : char;
  }
  return safe || "_jobmate_resume.pdf";
}

function resumeDataUrl(base64, mimeType) {
  const type = String(mimeType || "application/pdf");
  return `data:${type};base64,${base64}`;
}

async function waitForDownloadComplete(downloadId, chromeApi, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const items = await chromeApi.downloads.search({ id: downloadId });
    const item = items?.[0];
    if (!item) throw new Error("Download entry missing.");
    if (item.state === "complete") return item;
    if (item.state === "interrupted") throw new Error("Download interrupted.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Download timed out.");
}

async function writeTempResumeFile(base64, mimeType, filename, chromeApi) {
  const safeName = safeDownloadFilename(filename);
  const downloadId = await new Promise((resolve, reject) => {
    chromeApi.downloads.download(
      {
        url: resumeDataUrl(base64, mimeType),
        filename: `JobMate/${safeName}`,
        conflictAction: "overwrite",
        saveAs: false
      },
      (id) => {
        const err = chromeApi.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      }
    );
  });
  if (!downloadId) throw new Error("Download id missing.");
  try {
    const item = await waitForDownloadComplete(downloadId, chromeApi);
    if (!item.filename) throw new Error("Download path missing.");
    return { downloadId, filePath: item.filename };
  } catch (err) {
    await chromeApi.downloads.removeFile(downloadId);
    await chromeApi.downloads.erase({ id: downloadId });
    throw err;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let capturedDownload = null;
const chromeApi = {
  runtime: { lastError: null },
  downloads: {
    download(options, callback) {
      capturedDownload = options;
      callback(12);
    },
    async search() {
      return [{ id: 12, state: "complete", filename: "/tmp/JobMate/folder_file.pdf" }];
    }
  }
};

const result = await writeTempResumeFile("QUJD", "application/pdf", "folder/file.pdf", chromeApi);
assert(result.downloadId === 12, "Expected download id to be returned.");
assert(result.filePath === "/tmp/JobMate/folder_file.pdf", "Expected completed download path to be returned.");
assert(capturedDownload.url === "data:application/pdf;base64,QUJD", "Expected resume data URL download.");
assert(capturedDownload.filename === "JobMate/folder_file.pdf", "Expected path separators to be replaced.");
assert(capturedDownload.conflictAction === "overwrite", "Expected deterministic temp download conflict action.");
assert(capturedDownload.saveAs === false, "Expected non-interactive temp download.");

capturedDownload = null;
const defaultMimeChromeApi = {
  runtime: { lastError: null },
  downloads: {
    download(options, callback) {
      capturedDownload = options;
      callback(13);
    },
    async search() {
      return [{ id: 13, state: "complete", filename: "/tmp/JobMate/_jobmate_resume.pdf" }];
    }
  }
};

await writeTempResumeFile("REVG", "", "", defaultMimeChromeApi);
assert(capturedDownload.url === "data:application/pdf;base64,REVG", "Expected default PDF data URL.");
assert(capturedDownload.filename === "JobMate/_jobmate_resume.pdf", "Expected default temp filename.");

let missingPathError = null;
const cleanedDownloadIds = [];
const missingPathChromeApi = {
  runtime: { lastError: null },
  downloads: {
    download(options, callback) {
      callback(14);
    },
    async search() {
      return [{ id: 14, state: "complete" }];
    },
    async removeFile(id) {
      cleanedDownloadIds.push(id);
    },
    async erase(query) {
      cleanedDownloadIds.push(query.id);
    }
  }
};

try {
  await writeTempResumeFile("QUJD", "application/pdf", "resume.pdf", missingPathChromeApi);
} catch (err) {
  missingPathError = err;
}

assert(missingPathError?.message === "Download path missing.", "Expected missing download path to throw clearly.");
assert(cleanedDownloadIds.length === 2, "Expected missing-path temp download to be cleaned.");

let missingIdError = null;
const missingIdChromeApi = {
  runtime: { lastError: null },
  downloads: {
    download(options, callback) {
      callback(null);
    },
    async search() {
      throw new Error("Search should not run without a download id.");
    }
  }
};

try {
  await writeTempResumeFile("QUJD", "application/pdf", "resume.pdf", missingIdChromeApi);
} catch (err) {
  missingIdError = err;
}

assert(missingIdError?.message === "Download id missing.", "Expected missing download id to throw clearly.");
