import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import nextConfig from "../../next.config";
import { securityConfig } from "./config";

/**
 * Release checklist as code (SD Elements T49). CI runs it with every build, so a release cannot
 * ship demo or debug features, dead modules, placeholder assets, published source maps or test
 * helpers in application code.
 */
const root = process.cwd();
const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const isTest = (file: string) => /\.test\.tsx?$/.test(file) || rel(file).startsWith("src/test/");
const appFiles = walk(path.join(root, "src")).filter((file) => /\.(ts|tsx)$/.test(file) && !isTest(file));

test("release: production configuration keeps demo, test and debug features off", () => {
  const production = securityConfig({ NODE_ENV: "production" });
  assert.equal(production.demoMode, false, "simulation tools are off in a release");
  assert.equal(production.mailTransport, "disabled", "no memory or console mail transport in production");
  assert.equal(securityConfig({ NODE_ENV: "production", MAIL_TRANSPORT: "memory" }).mailTransport, "disabled");
  assert.equal(nextConfig.poweredByHeader, false, "no framework banner in responses");
  assert.equal(nextConfig.productionBrowserSourceMaps, false, "no browser source maps (and their comments) are published");
});

test("release: no debug statements or developer notes in application code", () => {
  const offenders = appFiles.flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /console\.(log|debug|trace)\(|\bdebugger\b|\b(TODO|FIXME|HACK|XXX)\b/.test(line))
      .map(({ index }) => `${rel(file)}:${index + 1}`),
  );
  assert.deepEqual(offenders, []);
});

/** Resolves an import specifier of `importer` to a file in the repository, if it is one. */
function resolveImport(importer: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(importer), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test("release: every application module is used, so no dead code ships", () => {
  const importers = [...appFiles, path.join(root, "next.config.ts")];
  const used = new Set<string>();
  for (const importer of importers) {
    const source = readFileSync(importer, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const target = resolveImport(importer, match[1]);
      if (target) used.add(target);
    }
  }
  // Files Next.js loads by convention are entry points.
  const entry = /(^|\/)(page|layout|route|loading|error|not-found)\.tsx?$|^src\/(proxy|instrumentation)\.ts$/;
  const unused = appFiles.filter((file) => !entry.test(rel(file)) && !used.has(file)).map(rel);
  assert.deepEqual(unused, []);
});

test("release: only referenced static assets are shipped", () => {
  const assets = existsSync(path.join(root, "public")) ? walk(path.join(root, "public")).map((file) => rel(file).replace(/^public/, "")) : [];
  const corpus = appFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.deepEqual(assets.filter((asset) => !corpus.includes(asset)), [], "placeholder assets from the project template are removed");
});

test("release: test helpers stay out of application code", () => {
  const offenders = appFiles.filter((file) => /from\s+["'][^"']*\/test\/support["']/.test(readFileSync(file, "utf8"))).map(rel);
  assert.deepEqual(offenders, []);
});

test("release: the example environment file carries no secret values", () => {
  const entries = readFileSync(path.join(root, ".env.example"), "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  assert.ok(entries.length > 5);
  for (const [name, value] of entries) {
    assert.ok(value === "" || /YOUR_|your-|replace_me/.test(value), `${name} must be empty or a placeholder`);
  }
});
