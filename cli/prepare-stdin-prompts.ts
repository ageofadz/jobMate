export const INK_HANDOFF_DELAY_MS = 100;

export async function waitAfterInkUnmount() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, INK_HANDOFF_DELAY_MS);
  });
}

export function prepareStdinBeforeExternalPrompts() {
  if (typeof process.stdin.ref === "function") {
    process.stdin.ref();
  }

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
}
