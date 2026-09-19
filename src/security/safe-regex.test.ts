// Covers safe-regex checks for risky user-supplied patterns.
import { describe, expect, it } from "vitest";
import {
  compileJsonSchemaPatternRegexDetailed,
  compileSafeRegex,
  compileSafeRegexDetailed,
  testRegexWithBoundedInput,
} from "./safe-regex.js";

function expectCompiledRegex(pattern: string, flags?: string): RegExp {
  const re = compileSafeRegex(pattern, flags);
  expect(re).toBeInstanceOf(RegExp);
  if (!re) {
    throw new Error(`Expected ${pattern} to compile safely`);
  }
  return re;
}

describe("safe regex", () => {
  it.each([
    ["(a+)+$", null],
    ["(a|aa)+$", null],
    ["(a|aa){2}$", RegExp],
  ] as const)("compiles %s safely", (pattern, expected) => {
    if (expected === null) {
      expect(compileSafeRegex(pattern)).toBeNull();
      return;
    }
    expect(compileSafeRegex(pattern)).toBeInstanceOf(expected);
  });

  it("compiles common safe filter regex", () => {
    const re = expectCompiledRegex("^agent:.*:discord:");
    expect(re.test("agent:main:discord:channel:123")).toBe(true);
    expect(re.test("agent:main:telegram:channel:123")).toBe(false);
  });

  it("supports explicit flags", () => {
    const re = expectCompiledRegex("token=([A-Za-z0-9]+)", "gi");
    expect("TOKEN=abcd1234".replace(re, "***")).toBe("***");
  });

  it.each([
    ["   ", "empty"],
    ["(a+)+$", "unsafe-nested-repetition"],
    ["(invalid", "invalid-regex"],
    ["^agent:main$", null],
  ] as const)("returns structured reject reason for %s", (pattern, expected) => {
    expect(compileSafeRegexDetailed(pattern).reason).toBe(expected);
  });

  it.each([
    [/^agent:main:discord:/, `agent:main:discord:${"x".repeat(5000)}`, true],
    [/discord:tail$/, `${"x".repeat(5000)}discord:tail`, true],
    [/discord:tail$/, `${"x".repeat(5000)}telegram:tail`, false],
  ] as const)("checks bounded regex windows for %s", (pattern, input, expected) => {
    expect(testRegexWithBoundedInput(pattern, input)).toBe(expected);
  });

  it("keeps custom adjacent-class redaction patterns on the shared compiler", () => {
    const compiled = compileSafeRegexDetailed("corp-[A-Z]+[A-Z]+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-ABCDEFGHIJKLMNOP")).toBe(true);
  });

  it("keeps disjoint escaped custom redaction alternatives on the shared compiler", () => {
    const compiled = compileSafeRegexDetailed("corp-(\\x41|BCD)+");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("corp-ABCD")).toBe(true);
    expect(compiled.regex?.test("corp-BCD")).toBe(true);
  });

  it("compiles JSON Schema patterns without trimming significant spaces", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed(" a");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test(" a")).toBe(true);
  });

  it("compiles empty JSON Schema patterns as match-all", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("x")).toBe(true);
    expect(compiled.regex?.test("mode")).toBe(true);
  });

  it("accepts safe disjoint JSON Schema alternatives", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(a|bc)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("a")).toBe(true);
    expect(compiled.regex?.test("bc")).toBe(true);
    expect(compiled.regex?.test("abc")).toBe(true);
    expect(compiled.regex?.test("zz")).toBe(false);
  });

  it("accepts disjoint character-class JSON Schema alternatives", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^([ab]|cd)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("a")).toBe(true);
    expect(compiled.regex?.test("b")).toBe(true);
    expect(compiled.regex?.test("cd")).toBe(true);
    expect(compiled.regex?.test("acd")).toBe(true);
    expect(compiled.regex?.test("zz")).toBe(false);
  });

  it("rejects nested alternatives that share a possible prefix", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^((a|b)|bb)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects semantically overlapping adjacent JSON Schema atoms", () => {
    expect(compileJsonSchemaPatternRegexDetailed("a*[a]*$").reason).toBe(
      "unsafe-nested-repetition",
    );
    expect(compileSafeRegexDetailed("a*[a]*$").reason).toBeNull();
  });

  it("still rejects overlapping JSON Schema alternatives", () => {
    expect(compileJsonSchemaPatternRegexDetailed("(a|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("accepts disjoint multi-character JSON Schema groups", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(ab)+(cd)+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("abcd")).toBe(true);
    expect(compiled.regex?.test("ababcd")).toBe(true);
    expect(compiled.regex?.test("ab")).toBe(false);
    expect(compiled.regex?.test("cd")).toBe(false);
  });

  it("rejects hex-escape alternatives that share a decoded prefix", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(\\x61|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects JSON Schema alternatives that overlap on non-ASCII whitespace", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(\\s|[\\u00a0][\\u00a0])+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects nested-repetition JSON Schema patterns", () => {
    expect(compileJsonSchemaPatternRegexDetailed("(a+)+$").reason).toBe("unsafe-nested-repetition");
  });

  it("rejects adjacent unbounded JSON Schema twins without changing the shared compiler", () => {
    expect(compileJsonSchemaPatternRegexDetailed("a*a*$").reason).toBe("unsafe-nested-repetition");
    expect(compileSafeRegexDetailed("a*a*$").reason).toBeNull();
  });

  it("rejects unparsed alternating groups adjacent to overlapping repetitions", () => {
    expect(compileJsonSchemaPatternRegexDetailed("^(a|b)+b+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects noncapturing groups with overlapping alternatives", () => {
    expect(compileSafeRegexDetailed("^(?:a|aaa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(?:a|aaa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("rejects backreference alternatives as unknown prefix languages", () => {
    expect(compileSafeRegexDetailed("^(a)(\\1|aa)+$").reason).toBe("unsafe-nested-repetition");
    expect(compileJsonSchemaPatternRegexDetailed("^(a)(\\1|aa)+$").reason).toBe(
      "unsafe-nested-repetition",
    );
  });

  it("accepts disjoint alternating groups adjacent to a different repetition", () => {
    const compiled = compileJsonSchemaPatternRegexDetailed("^(a|b)+c+$");
    expect(compiled.reason).toBeNull();
    expect(compiled.regex?.test("ac")).toBe(true);
    expect(compiled.regex?.test("bbc")).toBe(true);
    expect(compiled.regex?.test("ab")).toBe(false);
  });
});
