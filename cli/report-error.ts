import util from "node:util";

export function reportError(where: string, err: unknown) {
  const parts = [`\n━━ JobMate: ${where} ━━`];

  if (err instanceof Error) {
    parts.push(err.message);
    if (err.stack) {
      parts.push(err.stack);
    }
  } else {
    parts.push(util.inspect(err, { depth: 12, colors: false }));
  }

  parts.push("");
  process.stderr.write(parts.join("\n"));
}

export function installGlobalErrorHooks() {
  process.on("unhandledRejection", (reason) => {
    const e =
      reason instanceof Error
        ? reason
        : new Error(typeof reason === "string" ? reason : util.inspect(reason, { depth: 8 }));
    reportError("unhandledRejection", e);
  });

  process.on("uncaughtException", (err) => {
    reportError("uncaughtException", err);
  });
}
