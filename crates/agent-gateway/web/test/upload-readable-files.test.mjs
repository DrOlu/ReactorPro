import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { readFetchError } = loader.loadModule("src/lib/uploadReadableFiles.ts");

const NGINX_413_HTML = [
  "<html>",
  "<head><title>413 Request Entity Too Large</title></head>",
  "<body>",
  "<center><h1>413 Request Entity Too Large</h1></center>",
  "<hr><center>nginx</center>",
  "</body>",
  "</html>",
  "<!-- a padding to disable MSIE and Chrome friendly error page -->",
].join("\n");

test("readFetchError maps 413 to a friendly size message without the proxy HTML", async () => {
  const response = new Response(NGINX_413_HTML, { status: 413 });
  const message = await readFetchError(response, "Failed to import files");
  assert.match(message, /too large/i);
  assert.match(message, /HTTP 413/);
  assert.doesNotMatch(message, /<html>|nginx/);
});

test("readFetchError falls back with status for non-413 HTML error pages", async () => {
  const response = new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
  const message = await readFetchError(response, "Failed to import files");
  assert.match(message, /^Failed to import files[（(]HTTP 502[）)]$/);
});

test("readFetchError prefers structured gateway error payloads", async () => {
  const jsonError = new Response(JSON.stringify({ error: "Working directory does not exist or is not accessible" }), {
    status: 400,
  });
  assert.equal(await readFetchError(jsonError, "Failed to import files"), "Working directory does not exist or is not accessible");

  const jsonMessage = new Response(JSON.stringify({ message: "desktop offline" }), { status: 503 });
  assert.equal(await readFetchError(jsonMessage, "Failed to import files"), "desktop offline");

  const emptyJson = new Response(JSON.stringify({}), { status: 500 });
  assert.match(await readFetchError(emptyJson, "Failed to import files"), /^Failed to import files[（(]HTTP 500[）)]$/);
});

test("readFetchError keeps short plain-text bodies and drops oversized ones", async () => {
  const plain = new Response("desktop agent unreachable", { status: 502 });
  assert.equal(await readFetchError(plain, "Failed to import files"), "desktop agent unreachable");

  const oversized = new Response("x".repeat(2000), { status: 500 });
  assert.match(await readFetchError(oversized, "Failed to import files"), /^Failed to import files[（(]HTTP 500[）)]$/);

  const emptyBody = new Response("", { status: 500 });
  assert.match(await readFetchError(emptyBody, "Failed to import files"), /^Failed to import files[（(]HTTP 500[）)]$/);
});