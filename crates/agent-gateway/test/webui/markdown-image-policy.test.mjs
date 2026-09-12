import assert from "node:assert/strict";
import test from "node:test";

import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  mocks: {
    "@streamdown/cjk": {
      cjk: {},
    },
    "@streamdown/code": {
      code: {},
    },
    "@streamdown/math": {
      math: {},
    },
    "@streamdown/mermaid": {
      mermaid: {},
    },
    streamdown: {
      Streamdown(props) {
        return { type: "Streamdown", props };
      },
      defaultRemarkPlugins: {},
      defaultRehypePlugins: {},
    },
    "./ui/button": {
      Button(props) {
        return { type: "Button", props };
      },
    },
    "../lib/shared/utils": {
      cn: (...parts) => parts.filter(Boolean).join(" "),
    },
  },
});

const markdownModule = loader.loadModule("@liveagent/ui/components/Markdown.tsx");

test("webui markdown image syntax also falls back to alt text", () => {
  const node = markdownModule.markdownComponents.img({
    alt: "Dongmen Old Street",
    title: "Shenzhen Night View",
  });

  assert.ok(node);
  assert.equal(node.type, "span");
  assert.equal(node.props["data-liveagent-markdown-image"], "text-fallback");
  assert.equal(node.props.title, "Dongmen Old Street");
  assert.equal(node.props.children, "Dongmen Old Street");

  const empty = markdownModule.markdownComponents.img({});
  assert.equal(empty, null);
});
