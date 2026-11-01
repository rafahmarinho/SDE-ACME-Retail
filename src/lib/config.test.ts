import assert from "node:assert/strict";
import test from "node:test";
import { describeSettings, securityConfig } from "./config";
import { passwordIssues } from "./security";
import { buildPageCsp, HSTS_VALUE } from "./security-headers";
import nextConfig from "../../next.config";
import { captureLogs } from "../test/support";

captureLogs();

test("secure defaults apply when nothing is configured", () => {
  const config = securityConfig({});
  assert.equal(config.sessionIdleMinutes, 30);
  assert.equal(config.sessionMaxAgeMinutes, 720);
  assert.equal(config.lockoutThreshold, 5);
  assert.equal(config.passwordMinLength, 12);
  assert.deepEqual(config.passwordClasses, ["lower", "upper", "digit", "symbol"]);
  assert.equal(config.passwordHistory, 3);
  assert.equal(config.mailTransport, "memory");
  assert.equal(securityConfig({ NODE_ENV: "production" }).mailTransport, "disabled");
  assert.equal(securityConfig({ NODE_ENV: "production" }).demoMode, false, "demo and simulation features are off in production");
  assert.equal(securityConfig({ NODE_ENV: "production", ACME_DEMO_MODE: "enabled" }).demoMode, true, "a demo deployment opts in explicitly");
  assert.equal(securityConfig({ NODE_ENV: "production", MAIL_TRANSPORT: "console" }).mailTransport, "disabled", "console mail is refused in production");
});

test("values outside the safe range never weaken a control", () => {
  const config = securityConfig({
    AUTH_LOCKOUT_THRESHOLD: "50",
    PASSWORD_MIN_LENGTH: "6",
    PASSWORD_HISTORY: "0",
    PASSWORD_REQUIRE_CLASSES: "lower",
    SESSION_IDLE_MINUTES: "600",
    APP_ORIGIN: "http://shop.example",
    MAIL_WEBHOOK_URL: "http://mail.example/send",
  });
  assert.equal(config.lockoutThreshold, 5);
  assert.equal(config.passwordMinLength, 12);
  assert.equal(config.passwordHistory, 3);
  assert.equal(config.passwordClasses.length, 4);
  assert.equal(config.sessionIdleMinutes, 30);
  assert.equal(config.appOrigin, null, "plain http origins are refused outside localhost");
  assert.equal(config.mailWebhookUrl, null);
});

test("administrators can configure the password policy: length, classes, age, history and blocked words", () => {
  const config = securityConfig({
    PASSWORD_MIN_LENGTH: "16",
    PASSWORD_REQUIRE_CLASSES: "lower,upper,digit",
    PASSWORD_HISTORY: "5",
    PASSWORD_MAX_AGE_DAYS: "90",
    PASSWORD_MIN_AGE_HOURS: "24",
    PASSWORD_BLOCKLIST: "harbor,lighthouse",
  });
  assert.equal(config.passwordHistory, 5);
  assert.equal(config.passwordMaxAgeDays, 90);
  assert.equal(config.passwordMinAgeHours, 24);
  assert.ok(passwordIssues("Kq7-Wzt-Lmx-81", {}, config).includes("Use at least 16 characters."));
  assert.deepEqual(passwordIssues("Kq7WztLmxPvbn81r", {}, config), [], "symbols are optional when not required");
  assert.ok(passwordIssues("Lighthouse-Qz-81!", {}, config).includes("Avoid common passwords and dictionary words."));
  assert.deepEqual(passwordIssues("Lighthouse-Qz-81!", {}, securityConfig({})), []);
});

test("every security setting is documented with purpose, options, default, relevance, impact and relations", () => {
  const docs = describeSettings();
  const configKeys = Object.keys(securityConfig({})).filter((key) => key !== "production");
  for (const key of configKeys) assert.ok(docs.some((doc) => doc.key === key), `${key} is not documented`);
  for (const doc of docs) {
    for (const field of ["env", "purpose", "options", "default", "security", "impact"] as const) {
      assert.ok(doc[field].length > 0, `${doc.key}.${field} is empty`);
    }
    for (const related of doc.related) assert.ok(docs.some((other) => other.key === related), `${doc.key} relates to unknown ${related}`);
  }
});

test("deployed headers: HSTS everywhere, no-store on confidential pages, locked-down API CSP", async () => {
  const rules = await nextConfig.headers!();
  const find = (source: string, key: string) => rules.find((rule) => rule.source === source)?.headers.find((header) => header.key === key)?.value;
  assert.equal(find("/:path*", "Strict-Transport-Security"), HSTS_VALUE);
  assert.match(HSTS_VALUE, /max-age=(\d+); includeSubDomains/);
  assert.ok(Number(/max-age=(\d+)/.exec(HSTS_VALUE)![1]) >= 31536000);
  for (const source of ["/account/:path*", "/office/:path*", "/checkout", "/cart", "/login", "/recover", "/reset", "/api/:path*"]) {
    assert.equal(find(source, "Cache-Control"), "no-store, no-cache, must-revalidate, private, max-age=0", source);
    assert.equal(find(source, "Pragma"), "no-cache", source);
  }
  assert.equal(find("/api/:path*", "Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(find("/:path*", "Content-Security-Policy"), undefined, "page CSP comes from the proxy with a nonce");
  assert.equal(nextConfig.poweredByHeader, false);
});

test("page CSP forbids unsafe-inline and unsafe-eval in production and reports violations", () => {
  const csp = buildPageCsp("abc123", { development: false, https: true });
  const directive = (name: string) => csp.split("; ").find((part) => part.startsWith(`${name} `)) ?? "";
  assert.match(directive("script-src"), /'nonce-abc123' 'strict-dynamic'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(directive("default-src"), "default-src 'self'");
  assert.match(directive("connect-src"), /^connect-src 'self'/);
  assert.equal(directive("form-action"), "form-action 'self' https://checkout.stripe.com");
  assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
  assert.equal(directive("object-src"), "object-src 'none'");
  assert.equal(directive("report-uri"), "report-uri /api/csp-report");
  assert.ok(csp.includes("upgrade-insecure-requests"));
  assert.match(buildPageCsp("n", { development: true, https: false }), /'unsafe-eval'/, "development keeps React's eval-based debugging only");
});
