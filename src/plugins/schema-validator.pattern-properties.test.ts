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

  it("accepts disjoint multi-character groups on the plugin entrypoint", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.multi-char-disjoint",
      schema: {
        type: "object",
        patternProperties: {
          "^(ab)+(cd)+$": {
            type: "object",
            properties: {
              mode: { type: "string", default: "keep" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
      value: { abcd: {}, ab: {}, zz: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected multi-character patternProperties to validate");
    }
    expect(result.value).toEqual({
      abcd: { mode: "keep" },
      ab: {},
      zz: {},
    });
  });

  it("rejects hex-escape alternatives that share a decoded prefix on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.hex-escape-prefix",
        schema: {
          type: "object",
          patternProperties: {
            "^(\\x61|aa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { a: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects non-ASCII whitespace overlap on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.unicode-whitespace",
        schema: {
          type: "object",
          patternProperties: {
            "^(\\s|[\\u00a0][\\u00a0])+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { "\u00a0": "keep" },
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

  it("rejects unparsed alternating groups adjacent to overlapping repetitions", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.unparsed-group-adjacent",
        schema: {
          type: "object",
          patternProperties: {
            "^(a|b)+b+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { abb: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects noncapturing overlapping alternatives on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.noncapturing-overlap",
        schema: {
          type: "object",
          patternProperties: {
            "^(?:a|aaa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { a: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects backreference alternatives on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.backref-overlap",
        schema: {
          type: "object",
          patternProperties: {
            "^(a)(\\1|aa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { aaa: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("accepts disjoint alternating groups adjacent to a different repetition", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.alt-group-adjacent",
      schema: {
        type: "object",
        patternProperties: {
          "^(a|b)+c+$": {
            type: "object",
            properties: {
              mode: { type: "string", default: "keep" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
      value: { ac: {}, bbc: {}, zz: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected alternating-group patternProperties to validate");
    }
    expect(result.value).toEqual({
      ac: { mode: "keep" },
      bbc: { mode: "keep" },
      zz: {},
    });
  });

  it("rejects named backreferences on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.named-backref",
        schema: {
          type: "object",
          patternProperties: {
            "^(?<x>a)(\\k<x>|aa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { aaa: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects class-backspace overlap on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.class-backspace",
        schema: {
          type: "object",
          patternProperties: {
            "^([\\b]|\\x08\\x08)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { "\b": "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects lookahead-hidden overlapping alternatives on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.lookahead-overlap",
        schema: {
          type: "object",
          patternProperties: {
            "^((?!b)a|aaaa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { a: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects braced unicode identity-plus-quantifier without u on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.unicode-brace-identity",
        schema: {
          type: "object",
          patternProperties: {
            "^(\\u{2}|u)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { uu: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects control-escape overlap on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.control-escape",
        schema: {
          type: "object",
          patternProperties: {
            "^(\\cA|\\x01\\x01)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { "\x01": "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects nested alternative sequences that overlap adjacent groups on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.nested-alt-sequence",
        schema: {
          type: "object",
          patternProperties: {
            "^((ab|cd)e)+(abe)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { abeabe: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects octal-escape overlapping alternatives on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.octal-escape",
        schema: {
          type: "object",
          patternProperties: {
            "^(\\141|aaaa)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { a: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("rejects collapsed overlapping sequences on the plugin entrypoint", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.pattern-properties.collapsed-sequence",
        schema: {
          type: "object",
          patternProperties: {
            "^((ab|[a]b)c|abcabc)+$": { type: "string" },
          },
          additionalProperties: true,
        },
        value: { abcabc: "keep" },
      }),
    ).toThrow(/unsafe patternProperties/i);
  });

  it("accepts deterministic groups that share a first character on the plugin entrypoint", () => {
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.pattern-properties.shared-first-char",
      schema: {
        type: "object",
        patternProperties: {
          "^(ab)+(ac)+$": {
            type: "object",
            properties: {
              mode: { type: "string", default: "keep" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: true,
      },
      value: { abac: {}, ab: {}, zz: {} },
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected shared-first-character patternProperties to validate");
    }
    expect(result.value).toEqual({
      abac: { mode: "keep" },
      ab: {},
      zz: {},
    });
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
