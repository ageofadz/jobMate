function structurallyNeedsSuggestionPick(node) {
  if (!node) return false;
  const role = String(node.getAttribute("role") || "").toLowerCase();
  if (role === "combobox") return true;
  const ariaAutocomplete = String(node.getAttribute("aria-autocomplete") || "").toLowerCase();
  if (ariaAutocomplete && ariaAutocomplete !== "none") return true;
  return Boolean(node.getAttribute("aria-controls") || node.getAttribute("aria-owns"));
}

function suggestionFieldDiagnostics(item, node, answer, optionCount) {
  return [
    `No suggestions for "${item.field.label}".`,
    `Role: ${node.getAttribute("role") || ""}`,
    `Aria controls: ${node.getAttribute("aria-controls") || ""}`,
    `Aria expanded: ${node.getAttribute("aria-expanded") || ""}`,
    `Typed value: ${answer || ""}`,
    `Option count: ${optionCount}`,
    `Invalid: ${node.getAttribute("aria-invalid") || ""}`
  ].join(" ");
}

async function commitAriaSuggestionField(item, answer, optionCount, extensionMessage) {
  const node = item.node;
  if (!structurallyNeedsSuggestionPick(node)) {
    throw new Error(suggestionFieldDiagnostics(item, node, answer, optionCount));
  }
  const keyReply = await extensionMessage({ type: "JOBMATE_CDP_DISPATCH_KEYS", keys: ["ArrowDown", "Enter"] });
  if (!keyReply?.ok) {
    throw new Error(keyReply?.error || `Could not commit suggestion for "${item.field.label}".`);
  }
  if (node.getAttribute("aria-invalid") === "true") {
    throw new Error(`Validation failed for "${item.field.label}".`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testNode(attrs) {
  return {
    getAttribute(name) {
      return attrs[name] ?? "";
    }
  };
}

let message = null;
await commitAriaSuggestionField(
  {
    node: testNode({
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-controls": "menu-1",
      "aria-expanded": "false",
      "aria-invalid": "false"
    }),
    field: { label: "Ville" }
  },
  "Chicago",
  0,
  async (payload) => {
    message = payload;
    return { ok: true };
  }
);

assert(message.type === "JOBMATE_CDP_DISPATCH_KEYS", "Expected CDP key dispatch message.");
assert(message.keys.length === 2, "Expected two commit keys.");
assert(message.keys[0] === "ArrowDown", "Expected first key to select a suggestion.");
assert(message.keys[1] === "Enter", "Expected second key to commit a suggestion.");

let nonAriaError = null;
try {
  await commitAriaSuggestionField(
    { node: testNode({ role: "", "aria-invalid": "" }), field: { label: "Ville" } },
    "Chicago",
    0,
    async () => ({ ok: true })
  );
} catch (err) {
  nonAriaError = err;
}

assert(
  nonAriaError?.message === 'No suggestions for "Ville". Role:  Aria controls:  Aria expanded:  Typed value: Chicago Option count: 0 Invalid: ',
  "Expected non-ARIA field to fail with detailed no-suggestions diagnostic."
);

let invalidError = null;
try {
  await commitAriaSuggestionField(
    { node: testNode({ role: "combobox", "aria-invalid": "true" }), field: { label: "Ville" } },
    "Chicago",
    0,
    async () => ({ ok: true })
  );
} catch (err) {
  invalidError = err;
}

assert(invalidError?.message === "Validation failed for \"Ville\".", "Expected invalid combobox to fail clearly.");
