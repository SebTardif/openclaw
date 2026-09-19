// Tokenizes user-supplied regex sources for the safe-regex analyzer.

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

export type PatternToken =
  | { kind: "simple-token"; source: string }
  | { kind: "group-open"; contentStart: number }
  | { kind: "group-close"; start: number }
  | { kind: "alternation"; start: number; end: number }
  | { kind: "quantifier"; quantifier: QuantifierRead };

function readGroupContentStart(source: string, index: number): number {
  if (source[index + 1] !== "?") {
    return index + 1;
  }
  const marker = source[index + 2];
  if (marker === ":" || marker === "=" || marker === "!") {
    return index + 3;
  }
  if (marker !== "<") {
    return index + 1;
  }
  if (source[index + 3] === "=" || source[index + 3] === "!") {
    return index + 4;
  }
  const nameEnd = source.indexOf(">", index + 3);
  return nameEnd === -1 ? index + 1 : nameEnd + 1;
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

function isUnicodePropertyName(interior: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z0-9_]+)?$/.test(interior);
}

/**
 * Last index of one escape atom (`\p{L}`, `\u0041`, `\x41`), else the
 * one-char escape after `\`. Do not swallow `\p{(a+)+}`: without `u`,
 * `\p` is an identity escape and the group must still be analyzed.
 */
export function readEscapeAtomEnd(
  source: string,
  backslashIndex: number,
  unicodeMode = false,
): number {
  if (backslashIndex + 1 >= source.length) {
    return backslashIndex;
  }
  const kind = source[backslashIndex + 1];
  const afterKind = backslashIndex + 2;

  if ((kind === "p" || kind === "P") && source[afterKind] === "{") {
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && isUnicodePropertyName(source.slice(afterKind + 1, close))) {
      return close;
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && source[afterKind] === "{") {
    if (!unicodeMode) {
      return backslashIndex + 1;
    }
    const close = source.indexOf("}", afterKind + 1);
    if (close !== -1 && /^[0-9a-fA-F]{1,6}$/.test(source.slice(afterKind + 1, close))) {
      const cp = Number.parseInt(source.slice(afterKind + 1, close), 16);
      if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff) {
        return close;
      }
    }
    return backslashIndex + 1;
  }

  if (kind === "u" && /^[0-9a-fA-F]{4}/.test(source.slice(afterKind, afterKind + 4))) {
    return afterKind + 3;
  }

  if (kind === "x" && /^[0-9a-fA-F]{2}/.test(source.slice(afterKind, afterKind + 2))) {
    return afterKind + 1;
  }

  const octal = readLegacyOctalEscape(source, backslashIndex, unicodeMode);
  if (octal) {
    return octal.nextIndex - 1;
  }

  return backslashIndex + 1;
}

/**
 * Non-unicode `\141` is one octal atom (`a`), not `\1` plus leftover digits.
 * First digit 4-7 stops at two digits, so `\400` is `\40` plus literal `0`.
 * Unicode mode forbids octal; those stay one-char escapes / backrefs.
 */
function readLegacyOctalEscape(
  source: string,
  index: number,
  unicodeMode: boolean,
): { value: string; nextIndex: number } | null {
  if (unicodeMode || source[index] !== "\\") {
    return null;
  }
  const kind = source[index + 1];
  if (kind === undefined || kind < "0" || kind > "7") {
    return null;
  }
  let end = index + 1;
  const maxExtra = kind <= "3" ? 2 : 1;
  for (let extra = 0; extra < maxExtra; extra += 1) {
    const next = source[end + 1];
    if (next === undefined || next < "0" || next > "7") {
      break;
    }
    end += 1;
  }
  return {
    value: String.fromCharCode(Number.parseInt(source.slice(index + 1, end + 1), 8)),
    nextIndex: end + 1,
  };
}

/**
 * Octal that cannot be a backref: 3 digits (`\141`), a `\0` form, or
 * two digits starting with 4-7 (`\40`). Single `\1`..`\7` stay unproven
 * so `(a)(\1|aa)+` remains overlapping.
 */
export function readUnambiguousOctalEscape(
  source: string,
  index: number,
  unicodeMode: boolean,
): { value: string; nextIndex: number } | null {
  const octal = readLegacyOctalEscape(source, index, unicodeMode);
  if (!octal) {
    return null;
  }
  const digits = source.slice(index + 1, octal.nextIndex);
  const first = digits[0];
  const twoDigitHighOctal =
    digits.length === 2 && first !== undefined && first >= "4" && first <= "7";
  if (digits.length < 3 && !digits.startsWith("0") && !twoDigitHighOctal) {
    return null;
  }
  return octal;
}

export function tokenizePattern(source: string, flags = ""): PatternToken[] {
  const tokens: PatternToken[] = [];
  const unicodeMode = flags.includes("u") || flags.includes("v");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      const end = readEscapeAtomEnd(source, i, unicodeMode);
      tokens.push({ kind: "simple-token", source: source.slice(i, end + 1) });
      i = end;
      continue;
    }

    if (ch === "[") {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "]") {
          break;
        }
        i += 1;
      }
      tokens.push({
        kind: "simple-token",
        source: source.slice(start, Math.min(i + 1, source.length)),
      });
      continue;
    }

    if (ch === "(") {
      const contentStart = readGroupContentStart(source, i);
      tokens.push({ kind: "group-open", contentStart });
      i = contentStart - 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close", start: i });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation", start: i, end: i + 1 });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    tokens.push({ kind: "simple-token", source: source.slice(i, i + 1) });
  }

  return tokens;
}

const ZERO_WIDTH_SIMPLE_ATOMS = new Set(["^", "$", "\\b", "\\B"]);
const NAMED_CHAR_ESCAPES: Record<string, string> = {
  "\\n": "\n",
  "\\t": "\t",
  "\\r": "\r",
  "\\f": "\f",
  "\\v": "\v",
};

function isLookaroundGroupPrefix(source: string, contentStart: number): boolean {
  const prefix = source.slice(0, contentStart);
  return (
    prefix.endsWith("?=") ||
    prefix.endsWith("?!") ||
    prefix.endsWith("?<=") ||
    prefix.endsWith("?<!")
  );
}

function findMatchingGroupClose(tokens: readonly PatternToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      return -1;
    }
    if (token.kind === "group-open") {
      depth += 1;
    } else if (token.kind === "group-close") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function escapeDecodedLiteral(value: string): string {
  let escaped = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code < 0x80) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    escaped += `\\u{${code.toString(16)}}`;
  }
  return escaped;
}

/**
 * One consumed character for overlap compare, or null when width is unproven
 * (backref, incomplete escape). Decoded scalars are emitted as `\xNN`
 * / `\u{hex}` so `$` and `.` stay literals during overlap probing.
 */
function decodeFixedWidthSimpleToken(source: string, unicodeMode: boolean): string | null {
  if (!source.startsWith("\\")) {
    return source;
  }
  if (/^\\x[0-9a-fA-F]{2}$/.test(source)) {
    return escapeDecodedLiteral(String.fromCharCode(Number.parseInt(source.slice(2), 16)));
  }
  if (/^\\u[0-9a-fA-F]{4}$/.test(source)) {
    return escapeDecodedLiteral(String.fromCharCode(Number.parseInt(source.slice(2), 16)));
  }
  if (unicodeMode && /^\\u\{[0-9a-fA-F]{1,6}\}$/.test(source)) {
    const cp = Number.parseInt(source.slice(3, -1), 16);
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
      return null;
    }
    return escapeDecodedLiteral(String.fromCodePoint(cp));
  }
  const octal = readUnambiguousOctalEscape(source, 0, unicodeMode);
  if (octal && octal.nextIndex === source.length) {
    return escapeDecodedLiteral(octal.value);
  }
  const named = NAMED_CHAR_ESCAPES[source];
  if (named !== undefined) {
    return escapeDecodedLiteral(named);
  }
  if (source.length === 2) {
    const escaped = source[1];
    if (escaped !== undefined && !/[0-9A-Za-z]/.test(escaped)) {
      return escapeDecodedLiteral(escaped);
    }
  }
  if (/^\\[dDsSwW]$/.test(source) || source.startsWith("\\p{") || source.startsWith("\\P{")) {
    return source;
  }
  return null;
}

function collectFixedLengthAtoms(source: string, unicodeMode: boolean): string[] | null {
  const tokens = tokenizePattern(source, unicodeMode ? "u" : "");
  const atoms: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (!token) {
      return null;
    }
    if (
      token.kind === "quantifier" ||
      token.kind === "alternation" ||
      token.kind === "group-close"
    ) {
      return null;
    }
    if (token.kind === "group-open") {
      const closeIndex = findMatchingGroupClose(tokens, index);
      const close = tokens[closeIndex];
      if (closeIndex < 0 || !close || close.kind !== "group-close") {
        return null;
      }
      const contentStart = token.contentStart;
      if (isLookaroundGroupPrefix(source, contentStart)) {
        index = closeIndex + 1;
        continue;
      }
      const interior = source.slice(contentStart, close.start);
      if (interior) {
        const inner = collectFixedLengthAtoms(interior, unicodeMode);
        if (!inner) {
          return null;
        }
        atoms.push(...inner);
      }
      index = closeIndex + 1;
      continue;
    }
    if (ZERO_WIDTH_SIMPLE_ATOMS.has(token.source)) {
      index += 1;
      continue;
    }
    const decoded = decodeFixedWidthSimpleToken(token.source, unicodeMode);
    if (decoded === null) {
      return null;
    }
    atoms.push(decoded);
    index += 1;
  }
  return atoms.length > 0 ? atoms : null;
}

/**
 * Fixed-length atom sequence for one alternative, or null when a
 * quantifier, unknown-width atom, or unproven group makes length unknown.
 */
export function readFixedLengthAlternativeAtoms(
  source: string,
  unicodeMode = false,
): string[] | null {
  let body = source;
  if (body.startsWith("^")) {
    body = body.slice(1);
  }
  if (body.endsWith("$") && body.length > 0) {
    body = body.slice(0, -1);
  }
  if (!body) {
    return null;
  }
  return collectFixedLengthAtoms(body, unicodeMode);
}
