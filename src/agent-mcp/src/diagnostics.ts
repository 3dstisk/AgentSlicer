import { inspect } from "node:util";

export function logApiFailure(operation: string, error: unknown): void {
  const secrets = [process.env.AGENT_SLICER_TOKEN, process.env.AGENT_SLICER_POOL_TOKEN,
    process.env.AGENT_SLICER_POOL_WORKER_TOKEN].filter((value): value is string => Boolean(value));
  const redact = (value: string): string => {
    let result = value.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
    return result;
  };
  function details(value: unknown, depth = 0): unknown {
    if (depth > 5) return "[cause depth exceeded]";
    if (value instanceof Error) return {
      name: value.name, message: redact(value.message), stack: value.stack === undefined ? undefined : redact(value.stack),
      cause: value.cause === undefined ? undefined : details(value.cause, depth + 1),
      ...("code" in value ? { code: value.code } : {}),
      ...("details" in value ? { details: redact(inspect(value.details, { depth: 6, maxStringLength: 4096, maxArrayLength: 32 })) } : {}),
    };
    return redact(typeof value === "string" ? value : inspect(value, { depth: 5 }));
  }
  process.stderr.write(`${JSON.stringify({ level: "error", operation, error: details(error) })}\n`);
}
