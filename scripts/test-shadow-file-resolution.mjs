class TestElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.shadowRoot = null;
  }

  append(child) {
    this.children.push(child);
    return child;
  }

  attachShadowRoot() {
    this.shadowRoot = new TestRoot();
    return this.shadowRoot;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attrs[name];
  }

  querySelectorAll(selector) {
    return queryChildren(this.children, selector);
  }
}

class TestRoot {
  constructor() {
    this.children = [];
  }

  append(child) {
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector) {
    return queryChildren(this.children, selector);
  }
}

function matchesSelector(node, selector) {
  if (selector === "*") return true;
  if (selector === "input[type=\"file\"]") {
    return node.tagName === "INPUT" && node.getAttribute("type") === "file";
  }
  if (selector === "[data-jobmate-cdp-file-target=\"1\"]") {
    return node.getAttribute("data-jobmate-cdp-file-target") === "1";
  }
  if (selector === "[data-jobmate-field-id=\"resume-field\"]") {
    return node.getAttribute("data-jobmate-field-id") === "resume-field";
  }
  return false;
}

function queryChildren(children, selector) {
  const found = [];
  for (const child of children) {
    if (matchesSelector(child, selector)) found.push(child);
    for (const descendant of child.querySelectorAll(selector)) found.push(descendant);
  }
  return found;
}

function queryDeep(selector, root) {
  const found = [];
  for (const node of root.querySelectorAll(selector)) found.push(node);
  for (const host of root.querySelectorAll("*")) {
    if (host.shadowRoot) {
      for (const node of queryDeep(selector, host.shadowRoot)) found.push(node);
    }
  }
  return found;
}

function resolveFileInput(root, fieldId) {
  const mark = queryDeep("[data-jobmate-cdp-file-target=\"1\"]", root)[0];
  if (mark) {
    mark.removeAttribute("data-jobmate-cdp-file-target");
    return { element: mark, objectId: "object-resume", backendNodeId: 36 };
  }
  if (fieldId) {
    const found = queryDeep(`[data-jobmate-field-id="${fieldId}"]`, root)[0] || null;
    return found ? { element: found, objectId: "object-by-field-id", backendNodeId: 37 } : null;
  }
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const documentRoot = new TestRoot();
const photoInput = documentRoot.append(new TestElement("input", {
  type: "file",
  "data-jobmate-field-id": "photo-field"
}));
const host = documentRoot.append(new TestElement("spl-dropzone", {
  "data-test": "resume-upload"
}));
const shadow = host.attachShadowRoot();
const resumeInput = shadow.append(new TestElement("input", {
  type: "file",
  "data-jobmate-field-id": "resume-field",
  "data-jobmate-cdp-file-target": "1"
}));

const fileInputs = queryDeep("input[type=\"file\"]", documentRoot);
assert(fileInputs.length === 2, `Expected 2 file inputs, found ${fileInputs.length}`);
assert(fileInputs[0] === photoInput, "Expected light-DOM file input first.");
assert(fileInputs[1] === resumeInput, "Expected shadow-DOM resume input second.");

const marked = resolveFileInput(documentRoot, "photo-field");
assert(marked.element === resumeInput, "Expected marked shadow-DOM resume input to win over light-DOM field id.");
assert(marked.objectId === "object-resume", "Expected resolution to include an object id.");
assert(marked.backendNodeId === 36, "Expected resolution to include a diagnostic backend node id.");
assert(resumeInput.getAttribute("data-jobmate-cdp-file-target") === null, "Expected marker to be removed after resolution.");

const byFieldId = resolveFileInput(documentRoot, "resume-field");
assert(byFieldId.element === resumeInput, "Expected field-id lookup to find shadow-DOM resume input.");
assert(byFieldId.objectId === "object-by-field-id", "Expected field-id lookup to include an object id.");
assert(byFieldId.backendNodeId === 37, "Expected field-id lookup to include a diagnostic backend node id.");
