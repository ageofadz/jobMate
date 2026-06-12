async function forceAttachResumeToInput(input, file, uploadMeta, extensionMessage) {
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
  try {
    const reply = await extensionMessage({
      type: "JOBMATE_CDP_SET_FILE",
      fieldId: input.dataset.jobmateFieldId || "",
      base64: uploadMeta.base64,
      mimeType: uploadMeta.mimeType || file?.type,
      filename: uploadMeta.name || file?.name
    });
    if (reply?.ok) return { ok: true, ...reply };
    return {
      ok: false,
      error: reply?.error || "cdp_file_set_failed",
      stage: reply?.stage || "cdp_file_set",
      fieldId: reply?.fieldId || input.dataset.jobmateFieldId || "",
      backendNodeId: reply?.backendNodeId ?? null,
      fileCount: reply?.fileCount ?? null
    };
  } finally {
    delete input.dataset.jobmateCdpFileTarget;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const input = {
  dataset: { jobmateFieldId: "jm_12_file-input" },
  files: { length: 0 }
};

const result = await forceAttachResumeToInput(
  input,
  { type: "application/pdf", name: "resume.pdf" },
  { base64: "QUJD", mimeType: "application/pdf", name: "resume.pdf" },
  async () => ({
    ok: true,
    error: null,
    stage: "set_file_input_files",
    fieldId: "jm_12_file-input",
    backendNodeId: 36,
    fileCount: 1
  })
);

assert(result.ok === true, "Expected CDP success to be authoritative.");
assert(result.stage === "set_file_input_files", "Expected CDP stage to be preserved.");
assert(result.fileCount === 1, "Expected CDP file count to be preserved.");
assert(input.dataset.jobmateCdpFileTarget === undefined, "Expected marker to be removed.");

const failed = await forceAttachResumeToInput(
  { dataset: { jobmateFieldId: "jm_13_file-input" }, files: { length: 0 } },
  { type: "application/pdf", name: "resume.pdf" },
  { base64: "QUJD", mimeType: "application/pdf", name: "resume.pdf" },
  async () => ({
    ok: true,
    error: null,
    stage: "set_file_input_files",
    fieldId: "jm_13_file-input",
    backendNodeId: 37,
    fileCount: null
  })
);

assert(failed.ok === true, "Expected CDP file set success not to require a file count verifier.");
assert(failed.stage === "set_file_input_files", "Expected successful CDP set stage to be preserved.");
assert(failed.fileCount === null, "Expected file count to remain unset.");
