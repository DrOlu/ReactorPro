import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { normalizeLatexDelimiters } = loader.loadModule(
  "@liveagent/ui/lib/normalizeLatexDelimiters.ts",
);

test("uses the workspace-pinned KaTeX runtime and prefixed 0.18 CSS classes", () => {
  assert.equal(katex.version, "0.18.4");
  assert.match(katex.renderToString("x^2"), /class="katex-base"/);
});

test("renders invalid environment names as error markup when errors are non-throwing", () => {
  let html = "";
  assert.doesNotThrow(() => {
    html = katex.renderToString(String.raw`\begin{\pmatrix}`, { throwOnError: false });
  });
  assert.match(html, /class="katex-error"/);
});

test("normalizes LaTeX display and inline delimiters for Streamdown math", () => {
  const content = String.raw`2. Laplace form

\[
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
\]

where \(p_0\) is sea-level pressure.`;

  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`2. Laplace form

$$
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
$$

where $$p_0$$ is sea-level pressure.`,
  );
});

test("preserves existing dollar math and escaped LaTeX delimiters", () => {
  const content = String.raw`Existing $$x^2$$, literals \\(x\\) and \\[x\\].`;
  assert.equal(normalizeLatexDelimiters(content), content);
});

test("does not normalize delimiters inside Markdown or HTML code", () => {
  const content = [
    "Body \\(x\\).",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  const expected = [
    "Body $$x$$.",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content), expected);
});

test("preserves fenced code nested in blockquotes and lists", () => {
  const content = [
    "> ```latex",
    "> \\[",
    "> x",
    "> \\]",
    "> ```",
    "",
    "- ```latex",
    "  \\(",
    "  x",
    "  \\)",
    "  ```",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content, true), content);
});

test("keeps incomplete delimiters static and enables streaming completion", () => {
  const content = String.raw`Deriving: \[
H = 18400`;
  assert.equal(normalizeLatexDelimiters(content), content);
  assert.equal(normalizeLatexDelimiters(content, true), String.raw`Deriving: $$
H = 18400`);
});

test("converts single-dollar inline math to double-dollar", () => {
  const content = String.raw`Mass-energy equation $E = mc^2$, quadratic formula $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.`;
  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`Mass-energy equation $$E = mc^2$$, quadratic formula $$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$.`,
  );
});

test("keeps currency, shell variables, and escaped dollars literal", () => {
  const currency = "Price $5, cost $10. Total $15.";
  assert.equal(normalizeLatexDelimiters(currency), currency);

  const shell = "Check whether $PATH and $HOME are exported.";
  assert.equal(normalizeLatexDelimiters(shell), shell);

  const escaped = String.raw`Cost \$5 and \$10.`;
  assert.equal(normalizeLatexDelimiters(escaped), escaped);

  const digitAfterClose = "Unit price $3$5 promo.";
  assert.equal(normalizeLatexDelimiters(digitAfterClose), digitAfterClose);
});

test("single-dollar math must close on the same line", () => {
  const content = "Starting at $99\nnext day $x$ returns to full price.";
  assert.equal(normalizeLatexDelimiters(content), "Starting at $99\nnext day $$x$$ returns to full price.");
});

test("mixed currency and math on one line converts only the math pair", () => {
  const content = "Price $5, let $x$ denote the price.";
  assert.equal(normalizeLatexDelimiters(content), "Price $5, let $$x$$ denote the price.");
});

test("existing double-dollar spans stay opaque next to single-dollar math", () => {
  assert.equal(normalizeLatexDelimiters("Existing $$x^2$$ and $y$."), "Existing $$x^2$$ and $$y$$.");
});

test("streaming leaves unterminated dollar math untouched", () => {
  const inline = "Compute $E = mc^";
  assert.equal(normalizeLatexDelimiters(inline, true), inline);

  const display = "$$\nE = mc^2";
  assert.equal(normalizeLatexDelimiters(display, true), display);
});

test("does not convert dollars inside code spans or fences", () => {
  const content = [
    "Inline `sum $a$ b` preserved, formula $c$ converted.",
    "",
    "```sh",
    "echo $HOME $USER",
    "```",
  ].join("\n");
  const expected = [
    "Inline `sum $a$ b` preserved, formula $$c$$ converted.",
    "",
    "```sh",
    "echo $HOME $USER",
    "```",
  ].join("\n");
  assert.equal(normalizeLatexDelimiters(content), expected);
});
