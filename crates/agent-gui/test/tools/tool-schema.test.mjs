import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { normalizeToolParametersSchema } = loader.loadModule("src/lib/tools/toolSchema.ts");

test("a valid object schema is returned as-is", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  assert.deepEqual(normalizeToolParametersSchema(schema, "x"), schema);
});

test("an object missing type is filled in as an object schema", () => {
  const out = normalizeToolParametersSchema({ properties: { a: {} } }, "x");
  assert.equal(out.type, "object");
  assert.deepEqual(out.properties, { a: {} });
});

test("a top-level type other than object is corrected to object", () => {
  const out = normalizeToolParametersSchema({ type: "array", items: {} }, "x");
  assert.equal(out.type, "object");
});

test("non-object/array/undefined all fall back to the safe default", () => {
  assert.deepEqual(normalizeToolParametersSchema(undefined, "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema(null, "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema("nope", "x"), { type: "object" });
  assert.deepEqual(normalizeToolParametersSchema([1, 2], "x"), { type: "object" });
});
