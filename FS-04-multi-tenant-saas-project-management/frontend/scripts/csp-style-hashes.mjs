// Prints the CSP hash sources for the inline <style> elements the app creates at runtime, one per line.
// Run after `pnpm build` (the Docker image does this); exits non-zero if anything can't be extracted, so a
// changed dependency fails the build instead of shipping a CSP that silently unstyles part of the UI.
//
// Today that is sonner (toasts): on import it creates an empty <style>, then fills it with its CSS. The
// browser checks both states, so both hashes are needed: the exact CSS, and the empty string.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const hash = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const fail = (message) => {
  console.error(`csp-style-hashes: ${message}`);
  process.exit(1);
};

// The installed sonner's ESM build (what Vite bundles), resolved like the app resolves it.
let sonnerSource;
try {
  sonnerSource = readFileSync(join(dirname(require.resolve("sonner")), "index.mjs"), "utf8");
} catch (error) {
  fail(`can't read sonner's dist/index.mjs (${error.message})`);
}

const call = sonnerSource.match(/__insertCSS\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*\)/);
if (!call) fail("sonner no longer calls __insertCSS(<string literal>): re-check how it injects its styles");
let css;
try {
  css = JSON.parse(call[1].startsWith('"') ? call[1] : `"${call[1].slice(1, -1).replace(/"/g, '\\"')}"`);
} catch (error) {
  fail(`can't decode sonner's CSS string literal (${error.message})`);
}
if (!css.includes("[data-sonner-toaster]")) fail("extracted text doesn't look like sonner's stylesheet");

// The bundle must really ship this CSS; otherwise the hash would allow something the app doesn't run.
const assets = join(process.cwd(), "dist", "assets");
let bundled = false;
try {
  bundled = readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .some((name) => readFileSync(join(assets, name), "utf8").includes("--toast-icon-margin-start"));
} catch (error) {
  fail(`can't read the build output in dist/assets (${error.message}); run pnpm build first`);
}
if (!bundled) fail("the built bundle doesn't contain sonner's CSS: the hash would not match what runs");

console.log(hash(css));
console.log(hash(""));
