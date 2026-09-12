import type { Tool } from "@earendil-works/pi-ai";

// Dynamic sources (MCP servers / plugin manifests) provide standard JSON Schema, whereas pi-ai's
// Tool.parameters is nominally a typebox TSchema -- the two are isomorphic at runtime (both are plain
// objects) but have different types, so a cast across the boundary is required. The danger is not the cast
// itself but malformed values sent to the provider without validation, which cause hard-to-locate API errors.
// This function performs a lightweight structural guard before crossing the boundary: it ensures a non-empty,
// non-array object whose type is object (or is added when missing), otherwise it falls back to a safe default.
export function normalizeToolParametersSchema(input: unknown, label: string): Tool["parameters"] {
  const fallback = { type: "object" as const };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (input !== undefined && input !== null) {
      console.warn(
        `[tools] ${label} parameters is not a JSON Schema object; using {type:"object"}.`,
      );
    }
    return fallback as unknown as Tool["parameters"];
  }
  const obj = input as Record<string, unknown>;
  const type = obj.type;
  if (type !== undefined && type !== "object") {
    // The top level is not an object-type schema (e.g. array/string) -- tool-calling parameters must be an object.
    console.warn(
      `[tools] ${label} parameters has top-level type "${String(type)}"; coercing to object schema.`,
    );
    return { ...obj, type: "object" } as unknown as Tool["parameters"];
  }
  if (type === undefined) {
    // Add type to an object missing it to form an object schema, preventing provider errors from the missing field.
    return { type: "object", ...obj } as unknown as Tool["parameters"];
  }
  return obj as unknown as Tool["parameters"];
}
