// Inline SVG in chat messages.
//
// The default rehype-sanitize schema is an allow-list of 53 HTML tags with no
// SVG element in it at all, so a diagram an agent writes into a message is
// silently deleted before it renders. Markdown.tsx extends that allow-list with
// a small static subset; these tests pin both halves of the bargain — the
// drawing survives, and everything that makes SVG dangerous does not.
//
// The constants are read out of Markdown.tsx rather than duplicated here, so a
// change to the shipped allow-list cannot pass while these tests keep asserting
// yesterday's list.
//
// The attribute-name mapping is checked through a real HTML parse
// (hast-util-from-html, the parser rehype-raw uses for raw HTML blocks), because
// that is where an allow-list usually fails quietly: a schema listing `viewBox`
// does nothing if hast hands the sanitiser `viewbox`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { fromHtml } from "hast-util-from-html";
import { defaultSchema, sanitize } from "hast-util-sanitize";

const SOURCE = fileURLToPath(new URL("../src/components/Markdown.tsx", import.meta.url));
const source = readFileSync(SOURCE, "utf8");

function sliceConst(open, close) {
  const start = source.indexOf(open);
  assert.notEqual(start, -1, `could not find ${open} in Markdown.tsx`);
  const end = source.indexOf(close, start);
  assert.notEqual(end, -1, `could not find the end of ${open}`);
  return source.slice(start, end + close.length);
}

const { SVG_TAG_NAMES, SVG_ATTRIBUTES } = new Function(
  `${sliceConst("const SVG_PAINT_ATTRIBUTES = [", "];")}
   ${sliceConst("const SVG_TAG_NAMES = [", "];")}
   ${sliceConst("const SVG_ATTRIBUTES: Record<string, string[]> = {", "};").replace(": Record<string, string[]>", "")}
   return { SVG_TAG_NAMES, SVG_ATTRIBUTES };`,
)();

// The merge createSanitizedRehypePlugins performs, reproduced.
const schema = {
  ...defaultSchema,
  tagNames: [...new Set([...(defaultSchema.tagNames ?? []), ...SVG_TAG_NAMES])],
  attributes: { ...defaultSchema.attributes, ...SVG_ATTRIBUTES },
};

// Assert on the sanitised tree rather than on serialised HTML: property-level
// assertions cannot be satisfied by an attribute that merely happens to appear
// in a string, and they avoid depending on a serialiser.
const renderTree = (html) => sanitize(fromHtml(html, { fragment: true }), schema);

// textOf collects every text node, so a dropped caption is detectable.
function textOf(node, out = "") {
  if (node.type === "text") out += node.value;
  for (const child of node.children ?? []) out = textOf(child, out);
  return out;
}

function elementNames(node, out = []) {
  if (node.type === "element") out.push(node.tagName);
  for (const child of node.children ?? []) elementNames(child, out);
  return out;
}

function findElement(node, tagName) {
  if (node.type === "element" && node.tagName === tagName) return node;
  for (const child of node.children ?? []) {
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

const DIAGRAM = `
<svg viewBox="0 0 120 60" width="120" height="60">
  <g transform="translate(2 2)">
    <rect x="0" y="0" width="40" height="20" rx="3" fill="#eef" stroke="#336" stroke-width="2"/>
    <path d="M42 10 L70 10" stroke="#336" stroke-width="1.5" fill="none"/>
    <circle cx="82" cy="10" r="8" fill="#efe" stroke="#363"/>
    <text x="20" y="14" font-size="9" text-anchor="middle" fill="#336">edge</text>
  </g>
</svg>`;

// Hast property names are camelCase for known SVG attributes.
const props = (tree, tagName) => findElement(tree, tagName)?.properties ?? {};

test("a hand-written SVG diagram survives the sanitiser", () => {
  const tree = renderTree(DIAGRAM);
  const names = elementNames(tree);
  for (const tag of ["svg", "g", "rect", "path", "circle", "text"]) {
    assert.ok(names.includes(tag), `${tag} was dropped: ${names.join(",")}`);
  }
  assert.equal(props(tree, "svg").viewBox, "0 0 120 60", "viewBox did not survive the attribute-name mapping");
  // SVG numeric attributes stay strings in hast: they are number-or-percentage
  // types, so nothing coerces them.
  assert.equal(props(tree, "svg").width, "120");
  assert.equal(props(tree, "rect").strokeWidth, "2", "stroke-width did not survive");
  assert.equal(props(tree, "rect").rx, "3");
  assert.equal(props(tree, "g").transform, "translate(2 2)");
  assert.equal(props(tree, "path").d, "M42 10 L70 10");
  assert.equal(props(tree, "circle").cx, "82");
  assert.equal(props(tree, "text").textAnchor, "middle");
  assert.equal(props(tree, "text").fontSize, "9");
  assert.equal(textOf(tree).trim(), "edge", "the diagram's caption was dropped");
});

test("script inside SVG is removed, not unwrapped", () => {
  const tree = renderTree(
    `<svg viewBox="0 0 10 10"><script>alert(1)</script><rect x="1" y="1" width="2" height="2"/></svg>`,
  );
  const names = elementNames(tree);
  assert.ok(!names.includes("script"), `script survived: ${names.join(",")}`);
  assert.ok(!textOf(tree).includes("alert(1)"), "script source leaked into visible text");
  assert.ok(names.includes("rect"), "the sibling shape was lost along with the script");
});

test("event handlers and animations never reach the output", () => {
  const tree = renderTree(`
    <svg viewBox="0 0 10 10" onload="alert(1)">
      <rect x="0" y="0" width="5" height="5" onclick="alert(2)" onmouseover="alert(3)" style="position:fixed"/>
      <animate attributeName="x" from="0" to="9" dur="1s"/>
    </svg>`);
  const names = elementNames(tree);
  assert.ok(!names.includes("animate"), `animate was allowed: ${names.join(",")}`);
  for (const tag of ["svg", "rect"]) {
    for (const key of Object.keys(props(tree, tag))) {
      assert.ok(!/^on/i.test(key), `${tag} kept the handler ${key}`);
    }
  }
  assert.ok(!("style" in props(tree, "rect")), "a style attribute survived");
});

test("foreignObject cannot inject markup, only inert sanitised HTML", () => {
  const tree = renderTree(`
    <svg viewBox="0 0 10 10">
      <foreignObject width="10" height="10"><div><img src="x" onerror="alert(4)"></div></foreignObject>
    </svg>`);
  const names = elementNames(tree);
  assert.ok(!names.includes("foreignObject"), "foreignObject was preserved as an element");
  // hast-util-sanitize unwraps an unlisted element but keeps its children, so the
  // div survives as ordinary HTML. That is acceptable only because the children
  // go through the same schema — so assert the handler is gone, not the div.
  for (const key of Object.keys(props(tree, "img"))) {
    assert.ok(!/^on/i.test(key), `an event handler inside foreignObject survived: ${key}`);
  }
});

test("references to other documents are refused", () => {
  const tree = renderTree(`<svg viewBox="0 0 10 10"><use href="#icon" xlink:href="#icon"/></svg>`);
  const names = elementNames(tree);
  assert.ok(!names.includes("use"), "use was allowed");
  for (const tag of names) {
    for (const value of Object.values(props(tree, tag))) {
      assert.notEqual(value, "#icon", `a reference target survived on ${tag}`);
    }
  }
});

test("gradients are not offered, because they cannot resolve", () => {
  // The schema rewrites id with its `user-content-` clobber prefix while
  // fill="url(#fade)" is left alone, so a listed gradient would render flat
  // black. Refusing it outright is the honest option.
  const tree = renderTree(`
    <svg viewBox="0 0 10 10">
      <defs><linearGradient id="fade"><stop offset="0" stop-color="#333"/></linearGradient></defs>
      <rect x="0" y="0" width="10" height="10" fill="#333"/>
    </svg>`);
  const names = elementNames(tree);
  for (const tag of ["defs", "linearGradient", "radialGradient", "stop"]) {
    assert.ok(!names.includes(tag), `${tag} was allowed but cannot render correctly`);
  }
  assert.equal(props(tree, "rect").fill, "#333", "a solid fill should still work");
});

test("the allow-list stays minimal", () => {
  // A guard against the list quietly growing into "all of SVG".
  for (const forbidden of ["script", "foreignObject", "use", "animate", "style", "image", "a"]) {
    assert.ok(!SVG_TAG_NAMES.includes(forbidden), `${forbidden} must not be in the SVG allow-list`);
  }
  for (const tag of SVG_TAG_NAMES) {
    assert.ok(!tag.startsWith("on"), `${tag} looks like an event handler attribute`);
  }
  // No id anywhere: ids are the hook for reference-following, and the clobber
  // prefix would rewrite them anyway.
  for (const [tag, attributes] of Object.entries(SVG_ATTRIBUTES)) {
    assert.ok(!attributes.includes("id"), `${tag} allows id, which the clobber prefix would rewrite`);
    for (const attribute of attributes) {
      assert.ok(!/^on/i.test(attribute), `${tag} allows the handler ${attribute}`);
    }
  }
});
