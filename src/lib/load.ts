import { monitorEventLoopDelay } from "node:perf_hooks";
import { securityLog } from "./security-log";

/**
 * Event-loop load monitor (the "toobusy" pattern). The mean event-loop delay is sampled every
 * second; while it stays above BUSY_LAG_MS the API answers 503 with Retry-After instead of
 * queuing more work.
 */
export const BUSY_LAG_MS = 500;
const SAMPLE_MS = 1000;

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
let lagMs = 0;
let warned = false;
let lastTick = Date.now();

function sample() {
  const now = Date.now();
  // Both signals: the sampled delay histogram and how late this timer itself fired.
  const drift = now - lastTick - SAMPLE_MS;
  lastTick = now;
  lagMs = Math.max(histogram.max / 1e6, drift);
  histogram.reset();
  if (lagMs > BUSY_LAG_MS && !warned) {
    // The API pauses (answers 503) until the event loop recovers.
    warned = true;
    securityLog({ type: "server.busy", outcome: "blocked", detail: `paused: event loop delay ${Math.round(lagMs)} ms` });
  } else if (lagMs <= BUSY_LAG_MS && warned) {
    warned = false;
    securityLog({ type: "server.resumed", outcome: "info", detail: `event loop delay back to ${Math.round(lagMs)} ms` });
  }
}

setInterval(sample, SAMPLE_MS).unref();

export function eventLoopLagMs(): number {
  return lagMs;
}

export function serverTooBusy(): boolean {
  return lagMs > BUSY_LAG_MS;
}
