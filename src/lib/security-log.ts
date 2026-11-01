/**
 * Security event log. Entries are single-line JSON records on their own channel ("security"),
 * separate from application logs ("app"), so the hosting log drain can route and retain them
 * separately. User-controlled values are sanitized and length-limited.
 */
export type SecurityOutcome = "success" | "failure" | "blocked" | "info";

export interface SecurityEvent {
  type: string;
  outcome: SecurityOutcome;
  actorId?: string | null;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  detail?: string;
}

export interface LogEntry extends SecurityEvent {
  channel: "security" | "app" | "db";
  at: string;
  level?: "info" | "warn" | "error";
  errorId?: string;
  /** Database activity: transaction id and duration. */
  txId?: string;
  durationMs?: number;
}

type Sink = (entry: LogEntry) => void;

const consoleSink: Sink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else console.warn(line);
};

let sink: Sink = consoleSink;

/** Replaces the log destination (used by tests to capture entries). */
export function setLogSink(next: Sink | null) {
  sink = next ?? consoleSink;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").slice(0, max);
}

export function securityLog(event: SecurityEvent) {
  sink({
    channel: "security",
    at: new Date().toISOString(),
    level: event.outcome === "success" || event.outcome === "info" ? "info" : "warn",
    type: clean(event.type, 60) ?? "unknown",
    outcome: event.outcome,
    actorId: event.actorId ?? null,
    ip: clean(event.ip, 64),
    method: clean(event.method, 10),
    path: clean(event.path, 200),
    status: event.status,
    detail: clean(event.detail, 300),
  });
}

/**
 * Database and data-store activity (SD Elements T2602): commits with the IDs, field names and
 * non-personal values that changed, rollbacks with the reason, and every command sent to Supabase.
 */
export function dbLog(event: { type: string; outcome: SecurityOutcome; detail?: string; txId?: string; durationMs?: number }) {
  sink({
    channel: "db",
    at: new Date().toISOString(),
    level: event.outcome === "failure" ? "warn" : "info",
    type: clean(event.type, 60) ?? "unknown",
    outcome: event.outcome,
    txId: event.txId,
    durationMs: event.durationMs,
    detail: clean(event.detail, 1500),
  });
}

export function appErrorLog(errorId: string, error: unknown, context: { method?: string; path?: string } = {}) {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack?.split("\n").slice(1, 6).join(" | ") : undefined;
  sink({
    channel: "app",
    at: new Date().toISOString(),
    level: "error",
    type: "app.error",
    outcome: "failure",
    errorId,
    method: clean(context.method, 10),
    path: clean(context.path, 200),
    detail: clean(`${name}: ${message}${stack ? ` @ ${stack}` : ""}`, 1000),
  });
}
