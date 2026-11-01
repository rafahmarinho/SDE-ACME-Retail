/**
 * Browser helper for state-changing API calls. Every POST/PATCH carries the anti-CSRF token in
 * the X-CSRF-Token header (the server verifies it against its HttpOnly secret cookie, see
 * src/lib/csrf.ts). The token is kept only in memory: it comes from GET /api/session (or the
 * sign-in response) and is fetched again once when the server says it is no longer valid.
 */
const CSRF_HEADER = "X-CSRF-Token";

let csrfToken: string | null = null;
let pending: Promise<string | null> | null = null;

/** Stores the token returned by /api/session or by the sign-in response. */
export function rememberCsrfToken(token: unknown) {
  if (typeof token === "string" && token.length > 0) csrfToken = token;
}

async function fetchCsrfToken(): Promise<string | null> {
  pending ??= fetch("/api/session", { headers: { "X-Acme-Passive": "1" } })
    .then(async (response) => (response.ok ? ((await response.json()).csrfToken as string | undefined) ?? null : null))
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  csrfToken = await pending;
  return csrfToken;
}

/** Event answered by the step-up dialog (src/components/step-up-dialog.tsx). */
export const STEP_UP_EVENT = "acme-step-up";

export interface StepUpRequest {
  resolve: (confirmed: boolean) => void;
}

/** Asks the user for an additional authentication; resolves false when nobody can ask or the user cancels. */
function requestStepUp(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const event = new CustomEvent<StepUpRequest>(STEP_UP_EVENT, { detail: { resolve }, cancelable: true });
    // The dialog calls preventDefault() to take the request; otherwise nothing is shown.
    if (window.dispatchEvent(event)) resolve(false);
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.clone().json().catch(() => null)) as { code?: string } | null;
  return body?.code;
}

/**
 * fetch() for state-changing API requests, with the anti-CSRF token header. A request the server
 * marks as critical (step_up_required) is sent once more after the user confirms their identity.
 */
export async function apiSend(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (token) headers.set(CSRF_HEADER, token);
    return fetch(input, { ...init, headers });
  };
  let response = await send(csrfToken ?? (await fetchCsrfToken()));
  if (response.status !== 403) return response;
  let code = await errorCode(response);
  // The secret changes at sign-in and sign-out: get a fresh token and send the request once more.
  if (code === "csrf_invalid") {
    response = await send(await fetchCsrfToken());
    if (response.status !== 403) return response;
    code = await errorCode(response);
  }
  if (code === "step_up_required" && (await requestStepUp())) return send(csrfToken ?? (await fetchCsrfToken()));
  return response;
}
