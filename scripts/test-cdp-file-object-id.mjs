async function fileInputCountViaCdp(chromeApi, tabId, objectId) {
  const { result } = await chromeApi.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: "function() { return this.files ? this.files.length : 0; }",
    returnByValue: true
  });
  return Number(result?.value) || 0;
}

async function dispatchFileInputEventsViaCdp(chromeApi, tabId, objectId) {
  await chromeApi.debugger.sendCommand({ tabId }, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }`,
    returnByValue: true
  });
}

async function setFileInputFilesViaCdp(chromeApi, tabId, fileInputTarget, filePath) {
  if (!fileInputTarget?.objectId) throw new Error("Could not resolve file input object.");
  await chromeApi.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", {
    objectId: fileInputTarget.objectId,
    files: [filePath]
  });
  await dispatchFileInputEventsViaCdp(chromeApi, tabId, fileInputTarget.objectId);
  return { ok: true, fileCount: null };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const calls = [];
let runtimeCallCount = 0;
const chromeApi = {
  debugger: {
    async sendCommand(target, method, params) {
      calls.push({ target, method, params });
      if (method === "Runtime.callFunctionOn") {
        runtimeCallCount += 1;
        return { result: { value: runtimeCallCount === 2 ? 1 : null } };
      }
      return {};
    }
  }
};

const result = await setFileInputFilesViaCdp(chromeApi, 7, { objectId: "object-1", backendNodeId: 36 }, "/tmp/resume.pdf");
assert(result.ok === true, "Expected file set to verify.");
assert(result.fileCount === null, "Expected file count not to gate attachment success.");

const setFileCall = calls.find((call) => call.method === "DOM.setFileInputFiles");
assert(setFileCall, "Expected DOM.setFileInputFiles call.");
assert(setFileCall.params.objectId === "object-1", "Expected DOM.setFileInputFiles to use objectId.");
assert(!Object.hasOwn(setFileCall.params, "nodeId"), "Expected DOM.setFileInputFiles not to use nodeId.");
assert(!Object.hasOwn(setFileCall.params, "backendNodeId"), "Expected DOM.setFileInputFiles not to use backendNodeId.");

const runtimeCalls = calls.filter((call) => call.method === "Runtime.callFunctionOn");
assert(runtimeCalls.length === 1, "Expected only event dispatch runtime call.");
assert(runtimeCalls.every((call) => call.params.objectId === "object-1"), "Expected runtime calls to reuse objectId.");
assert(!calls.some((call) => call.method === "DOM.pushNodesByBackendIdsToFrontend"), "Expected no backend-node-to-node-id conversion.");

let missingObjectError = null;
try {
  await setFileInputFilesViaCdp(chromeApi, 7, { backendNodeId: 36 }, "/tmp/resume.pdf");
} catch (err) {
  missingObjectError = err;
}

assert(missingObjectError?.message === "Could not resolve file input object.", "Expected missing object id to fail clearly.");

const noCountChromeApi = {
  debugger: {
    async sendCommand(target, method) {
      calls.push({ target, method });
      if (method === "Runtime.callFunctionOn") {
        return { result: { value: null } };
      }
      return {};
    }
  }
};

const noCountResult = await setFileInputFilesViaCdp(noCountChromeApi, 7, { objectId: "object-2", backendNodeId: 37 }, "/tmp/resume.pdf");
assert(noCountResult.ok === true, "Expected missing file count not to fail the attachment.");
assert(noCountResult.fileCount === null, "Expected file count to remain unset.");
