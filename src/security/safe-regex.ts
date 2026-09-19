// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
  firstAtom: string;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAlternation: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  branchFirstAtom: string | null;
  altFirstAtoms: string[];
};

type PatternToken =
  | { kind: "simple-token"; sig: string }
  | { kind: "group-open" }
  | { kind: "group-close" }
  | { kind: "alternation" }
  | { kind: "quantifier"; quantifier: QuantifierRead };

const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
export type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";

export type SafeRegexCompileResult =
  | {
      regex: RegExp;
      source: string;
      flags: string;
      reason: null;
    }
  | {
      regex: null;
      source: string;
      flags: string;
      reason: SafeRegexRejectReason;
    };

const safeRegexCache = new Map<string, SafeRegexCompileResult>();

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
    branchFirstAtom: null,
    altFirstAtoms: [],
  };
}

function addLength(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return left + right;
}

function multiplyLength(length: number, factor: number): number {
  if (!Number.isFinite(length)) {
    return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return length * factor;
}

function recordAlternative(frame: ParseFrame): void {
  frame.altFirstAtoms.push(frame.branchFirstAtom ?? "");
  frame.branchFirstAtom = null;
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

function atomsCanMatchSamePrefix(left: string, right: string): boolean {
  if (left === right || !left || !right) {
    return true;
  }
  if (left === "." || right === ".") {
    return true;
  }
  if (left.startsWith("[") || right.startsWith("[")) {
    return true;
  }
  if (left.startsWith("\\") || right.startsWith("\\")) {
    return true;
  }
  return false;
}

function firstAtomsOverlap(atoms: readonly string[]): boolean {
  if (atoms.length < 2) {
    return false;
  }
  for (let i = 0; i < atoms.length; i += 1) {
    const left = atoms[i];
    if (left === undefined) {
      continue;
    }
    for (let j = i + 1; j < atoms.length; j += 1) {
      const right = atoms[j];
      if (right === undefined) {
        continue;
      }
      if (atomsCanMatchSamePrefix(left, right)) {
        return true;
      }
    }
  }
  return false;
}

function readCharClassSig(source: string, index: number): { end: number; sig: string } {
  let i = index + 1;
  if (source[i] === "^") {
    i += 1;
  }
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "]") {
      return { end: i + 1, sig: source.slice(index, i + 1) };
    }
    i += 1;
  }
  return { end: source.length, sig: source.slice(index) };
}

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  const consumed = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed, minRepeat: 0, maxRepeat: 1 };
  }
  if (ch !== "{") {
    return null;
  }

  let i = index + 1;
  while (i < source.length && /\d/.test(source.charAt(i))) {
    i += 1;
  }
  if (i === index + 1) {
    return null;
  }

  const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
  let maxRepeat: number | null = minRepeat;
  if (source[i] === ",") {
    i += 1;
    const maxStart = i;
    while (i < source.length && /\d/.test(source.charAt(i))) {
      i += 1;
    }
    maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
  }

  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  if (source[i] === "?") {
    i += 1;
  }
  if (maxRepeat !== null && maxRepeat < minRepeat) {
    return null;
  }

  return { consumed: i - index, minRepeat, maxRepeat };
}

function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      const next = source[i + 1];
      const sig = next === undefined ? "\\" : source.slice(i, i + 2);
      if (next !== undefined) {
        i += 1;
      }
      tokens.push({ kind: "simple-token", sig });
      continue;
    }

    if (ch === "[") {
      const atom = readCharClassSig(source, i);
      tokens.push({ kind: "simple-token", sig: atom.sig });
      i = atom.end - 1;
      continue;
    }

    if (ch === "(") {
      tokens.push({ kind: "group-open" });
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close" });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation" });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    tokens.push({ kind: "simple-token", sig: ch ?? "" });
  }

  return tokens;
}

function analyzeTokensForNestedRepetition(
  tokens: PatternToken[],
  distinguishDisjointAlternatives = false,
): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    if (frame.branchFirstAtom === null) {
      frame.branchFirstAtom = token.firstAtom;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
  };

  const emitSimpleToken = (sig: string) => {
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      minLength: 1,
      maxLength: 1,
      firstAtom: sig,
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken(token.sig);
      continue;
    }

    if (token.kind === "group-open") {
      frames.push(createParseFrame());
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        const lengthAmbiguous =
          frame.hasAlternation &&
          frame.altMinLength !== null &&
          frame.altMaxLength !== null &&
          frame.altMinLength !== frame.altMaxLength;
        const firstAtom = frame.hasAlternation
          ? firstAtomsOverlap(frame.altFirstAtoms)
            ? "."
            : (frame.altFirstAtoms[0] ?? "")
          : (frame.branchFirstAtom ?? "");
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation: distinguishDisjointAlternatives
            ? lengthAmbiguous && firstAtomsOverlap(frame.altFirstAtoms)
            : lengthAmbiguous,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
          firstAtom,
        });
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(frame);
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.lastToken = null;
      continue;
    }

    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    if (previousToken.containsRepetition) {
      return true;
    }
    if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) {
      return true;
    }

    const previousMinLength = previousToken.minLength;
    const previousMaxLength = previousToken.maxLength;
    previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
    previousToken.maxLength =
      token.quantifier.maxRepeat === null
        ? Number.POSITIVE_INFINITY
        : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
    previousToken.containsRepetition = true;
    frame.containsRepetition = true;
    frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;

    const branchMaxBase =
      Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
        ? frame.branchMaxLength - previousMaxLength
        : Number.POSITIVE_INFINITY;
    frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
  }

  return false;
}

function testRegexFromStart(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

export function testRegexWithBoundedInput(
  regex: RegExp,
  input: string,
  maxWindow = SAFE_REGEX_TEST_WINDOW,
): boolean {
  if (maxWindow <= 0) {
    return false;
  }
  if (input.length <= maxWindow) {
    return testRegexFromStart(regex, input);
  }
  const head = input.slice(0, maxWindow);
  if (testRegexFromStart(regex, head)) {
    return true;
  }
  return testRegexFromStart(regex, input.slice(-maxWindow));
}

function hasNestedRepetition(
  source: string,
  options?: { distinguishDisjointAlternatives?: boolean },
): boolean {
  // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
  // Non-goal: complete regex AST support; keep strict enough for config safety checks.
  return analyzeTokensForNestedRepetition(
    tokenizePattern(source),
    options?.distinguishDisjointAlternatives === true,
  );
}

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source: trimmed,
        flags,
        reason: "invalid-regex",
      }
    );
  }

  let result: SafeRegexCompileResult;
  if (hasNestedRepetition(trimmed)) {
    result = { regex: null, source: trimmed, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(trimmed, flags), source: trimmed, flags, reason: null };
    } catch {
      result = { regex: null, source: trimmed, flags, reason: "invalid-regex" };
    }
  }

  safeRegexCache.set(cacheKey, result);
  pruneMapToMaxSize(safeRegexCache, SAFE_REGEX_CACHE_MAX);
  return result;
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}

function readEscapeAtom(source: string, index: number): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === "p" || next === "P") {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      if (close !== -1) {
        return { end: close + 1, sig: source.slice(index, close + 1) };
      }
    }
  }
  if (next === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close !== -1) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  if (next === "u" && index + 5 < source.length) {
    return { end: index + 6, sig: source.slice(index, index + 6) };
  }
  if (next === "x" && index + 3 < source.length) {
    return { end: index + 4, sig: source.slice(index, index + 4) };
  }
  if (next !== undefined) {
    return { end: index + 2, sig: source.slice(index, index + 2) };
  }
  return { end: index + 1, sig: "\\" };
}

function readClassAtom(source: string, index: number): { end: number; sig: string } {
  let i = index + 1;
  if (source[i] === "^") {
    i += 1;
  }
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "]") {
      return { end: i + 1, sig: source.slice(index, i + 1) };
    }
    i += 1;
  }
  return { end: source.length, sig: source.slice(index) };
}

function readGroupAtom(
  source: string,
  index: number,
): { end: number; sig: string; zeroWidth: boolean } {
  const prefix = source.slice(index, index + 4);
  const zeroWidth =
    prefix.startsWith("(?=") ||
    prefix.startsWith("(?!") ||
    prefix.startsWith("(?<=") ||
    prefix.startsWith("(?<!");
  let depth = 1;
  let i = index + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "[") {
      i = readClassAtom(source, i).end;
      continue;
    }
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return { end: i, sig: source.slice(index, i), zeroWidth };
}

function signaturesEqual(left: string, right: string, foldCase: boolean): boolean {
  if (left === right) {
    return true;
  }
  if (foldCase && left.length === 1 && right.length === 1) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return false;
}

function hasAdjacentUnboundedTwins(source: string, flags = ""): boolean {
  let pending: string | null = null;
  let i = 0;
  const foldCase = flags.includes("i");

  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ")") {
      pending = null;
      i += 1;
      continue;
    }

    let end = i + 1;
    let sig = ch ?? "";
    let zeroWidth = false;
    if (ch === "\\") {
      const atom = readEscapeAtom(source, i);
      end = atom.end;
      sig = atom.sig;
    } else if (ch === "[") {
      const atom = readClassAtom(source, i);
      end = atom.end;
      sig = atom.sig;
    } else if (ch === "(") {
      const atom = readGroupAtom(source, i);
      end = atom.end;
      sig = atom.sig;
      zeroWidth = atom.zeroWidth;
    }

    i = end;
    const quantifier = readQuantifier(source, i);
    let unbounded = false;
    if (quantifier) {
      i += quantifier.consumed;
      unbounded = quantifier.maxRepeat === null;
    }

    if (unbounded) {
      if (pending !== null && signaturesEqual(pending, sig, foldCase)) {
        return true;
      }
      pending = sig;
      continue;
    }
    if (!zeroWidth) {
      pending = null;
    }
  }
  return false;
}

export function compileJsonSchemaPatternRegex(source: string, flags = ""): RegExp | null {
  return compileJsonSchemaPatternRegexDetailed(source, flags).regex;
}

/** Exact-source compile for JSON Schema patternProperties (do not trim). */
export function compileJsonSchemaPatternRegexDetailed(
  source: string,
  flags = "",
): SafeRegexCompileResult {
  const cacheKey = `schema::${flags}::${source}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source,
        flags,
        reason: "invalid-regex",
      }
    );
  }
  let result: SafeRegexCompileResult;
  if (
    hasNestedRepetition(source, { distinguishDisjointAlternatives: true }) ||
    hasAdjacentUnboundedTwins(source, flags)
  ) {
    result = { regex: null, source, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(source, flags), source, flags, reason: null };
    } catch {
      result = { regex: null, source, flags, reason: "invalid-regex" };
    }
  }
  safeRegexCache.set(cacheKey, result);
  pruneMapToMaxSize(safeRegexCache, SAFE_REGEX_CACHE_MAX);
  return result;
}
