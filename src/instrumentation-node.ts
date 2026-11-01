import { securityConfig } from "./lib/config";
import { securityLog } from "./lib/security-log";
import { keyHealth } from "./lib/keys";
import { encryptionEnabled } from "./lib/data-crypto";

export function registerNode() {
  const config = securityConfig();
  const storage = process.env.ACME_DATA_PATH === "memory" ? "memory" : process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "supabase" : "file";
  securityLog({
    type: "app.startup",
    outcome: "info",
    detail: `env=${process.env.NODE_ENV} storage=${storage} mail=${config.mailTransport} demoMode=${config.demoMode} appOrigin=${config.appOrigin ? "set" : "unset"} seedPassword=${process.env.ACME_SEED_PASSWORD ? "set" : "unset"} encryption=${encryptionEnabled() ? "on" : "off"}`,
  });
  // Key management (T60): format, single purpose, rotation age and required keys; values are never logged.
  for (const finding of keyHealth()) securityLog({ type: "keys.health", outcome: "blocked", detail: finding });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      securityLog({ type: "app.shutdown", outcome: "info", detail: signal });
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}
