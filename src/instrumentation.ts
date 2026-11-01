/**
 * Server start-up hook (Next.js instrumentation). The Node.js part records start-up, the
 * security-relevant configuration in effect (never secret values) and shutdown signals.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
