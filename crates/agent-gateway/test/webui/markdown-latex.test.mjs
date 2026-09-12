import assert from "node:assert/strict";
import test from "node:test";

import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// katex is not hoisted to the workspace root, so reach the web app's copy by
// file URL the same way load-web-module.mjs resolves pi-ai.
const { default: katex } = await import(
  new URL("../../web/node_modules/katex/dist/katex.mjs", import.meta.url).href
);

const loader = createWebModuleLoader();
const { normalizeLatexDelimiters } = loader.loadModule(
  "@liveagent/ui/lib/normalizeLatexDelimiters.ts",
);

test("webui uses the workspace-pinned KaTeX runtime and prefixed 0.18 CSS classes", () => {
  assert.equal(katex.version, "0.18.4");
  assert.match(katex.renderToString("x^2"), /class="katex-base"/);
});

test("webui renders invalid environment names as error markup when errors are non-throwing", () => {
  let html = "";
  assert.doesNotThrow(() => {
    html = katex.renderToString(String.raw`\begin{\pmatrix}`, { throwOnError: false });
  });
  assert.match(html, /class="katex-error"/);
});

test("webui normalizes LaTeX delimiters with the mirrored parser", () => {
  const content = String.raw`\[
p_0 = p \cdot 10^{\frac{H}{18400(1+t/273)}}
\]

where \(p_0\) is the sea-level pressure.`;

  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`$$
p_0 = p \cdot 10^{\frac{H}{18400(1+t/273)}}
$$

where $$p_0$$ is the sea-level pressure.`,
  );
});

test("webui preserves code and supports an incomplete streaming formula", () => {
  const fenced = ["```latex", "\\[", "x", "\\]", "```"].join("\n");
  assert.equal(normalizeLatexDelimiters(fenced, true), fenced);
  assert.equal(normalizeLatexDelimiters(String.raw`\(x`, true), "$$x");
});

test("webui converts single-dollar math and keeps currency literal", () => {
  assert.equal(normalizeLatexDelimiters("mass-energy equation $E = mc^2$."), "mass-energy equation $$E = mc^2$$.");

  const currency = "price $5, cost $10.";
  assert.equal(normalizeLatexDelimiters(currency), currency);

  const streamingInline = "compute $E = mc^";
  assert.equal(normalizeLatexDelimiters(streamingInline, true), streamingInline);
});
