/** Covers plugin schema patternProperties screening on the validation entrypoint. */
import { describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

vi.mock("typebox/compile", () => {
  throw new Error("schema validation must not load the TypeBox value-transform compiler");
});
vi.mock("typebox/value", () => {
  throw new Error("schema validation must not load TypeBox value transforms");
});

describe("schema validator patternProperties screening", () => {
  it("rejects nested-repetition patternProperties before TypeBox validation", () => {
    const value = { aaaaaaaaaaaaaaaaaaaaX: {} };
    const started = Date.now();
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.nested",
        schema: {
          type: "object",
          patternProperties: {
            "(a+)+$": {
              type: "object",
              properties: {
                mode: { type: "string", default: "applied" },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
        value,
        applyDefaults: true,
      }),
    ).toThrow(/unsafe patternProperties/i);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects adjacent unbounded patternProperties on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.adjacent",
        schema: {
          type: "object",
          patternProperties: {
            "a*a*$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { aaa: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("accepts safe disjoint patternProperties on the plugin entrypoint", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.disjoint",
      schema: {
        type: "object",
        patternProperties: {
          "^(a|bc)+$": {
            type: "object",
            properties: {
              mode: { type: "string", default: "keep" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
      value: { a: {}, bc: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected disjoint patternProperties to validate");
    }
    expect(result.value).toEqual({
      a: { mode: "keep" },
      bc: { mode: "keep" },
    });
  });

  it("accepts disjoint character-class patternProperties on the plugin entrypoint", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.class-disjoint",
      schema: {
        type: "object",
        patternProperties: {
          "^([ab]|cd)+$": {
            type: "object",
            properties: {
              mode: { type: "string", default: "keep" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
      value: { a: {}, cd: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected character-class patternProperties to validate");
    }
    expect(result.value).toEqual({
      a: { mode: "keep" },
      cd: { mode: "keep" },
    });
  });

  it("rejects nested alternatives that share a possible prefix", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.nested-prefix",
        schema: {
          type: "object",
          patternProperties: {
            "^((a|b)|bb)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { a: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects semantically overlapping adjacent patternProperties", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.semantic-adjacent",
        schema: {
          type: "object",
          patternProperties: {
            "a*[a]*$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { aaa: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("applies empty patternProperties defaults on the plugin entrypoint", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.empty",
      schema: {
        type: "object",
        patternProperties: {
          "": {
            type: "object",
            properties: {
              mode: { type: "string", default: "auto" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      value: { x: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected empty patternProperties to validate");
    }
    expect(result.value).toEqual({
      x: { mode: "auto" },
    });
  });
});
