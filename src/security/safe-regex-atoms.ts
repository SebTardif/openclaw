// Compares regex atom languages for schema-pattern ReDoS screening.
import { classifyNumericEscape, readNumericEscapeAtom } from "./safe-regex-numeric.js";

const DIGITS = "0123456789";
const WORD = `${DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_`;
const WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

type AtomLanguage =
  | { kind: "any" }
  | { kind: "chars"; chars: ReadonlySet<string> }
  | { kind: "complement"; chars: ReadonlySet<string> };

function foldedChars(chars: Iterable<string>, foldCase: boolean): Set<string> {
  const out = new Set<string>();
  for (const ch of chars) {
    out.add(ch);
    if (foldCase && ch.length === 1) {
      out.add(ch.toLowerCase());
      out.add(ch.toUpperCase());
    }
  }
  return out;
}

function singleton(ch: string, foldCase: boolean): AtomLanguage {
  return { kind: "chars", chars: foldedChars([ch], foldCase) };
}

function parseHexChar(hex: string): string | null {
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const code = Number.parseInt(hex, 16);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(code);
}

function isUnicodePropertyName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z0-9_-]+)?$/.test(value);
}

export function isUnicodeRegexMode(flags: string | undefined): boolean {
  return Boolean(flags && (flags.includes("u") || flags.includes("v")));
}

export function readCompleteEscapeAtom(
  source: string,
  index: number,
  options: { unicode?: boolean; capturingGroups?: number } = {},
): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === undefined) {
    return { end: index + 1, sig: "\\" };
  }
  if (next === "p" || next === "P") {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      if (close !== -1 && isUnicodePropertyName(source.slice(index + 3, close))) {
        return { end: close + 1, sig: source.slice(index, close + 1) };
      }
    }
  }
  if (options.unicode && next === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close !== -1 && parseHexChar(source.slice(index + 3, close))) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  const unicodeHex = source.slice(index + 2, index + 6);
  if (next === "u" && unicodeHex.length === 4 && parseHexChar(unicodeHex)) {
    return { end: index + 6, sig: source.slice(index, index + 6) };
  }
  const hex = source.slice(index + 2, index + 4);
  if (next === "x" && hex.length === 2 && parseHexChar(hex)) {
    return { end: index + 4, sig: source.slice(index, index + 4) };
  }
  if (next === "k" && source[index + 2] === "<") {
    const close = source.indexOf(">", index + 3);
    if (close !== -1) {
      return { end: close + 1, sig: source.slice(index, close + 1) };
    }
  }
  if (next === "c") {
    const control = source[index + 2];
    if (control && /[A-Za-z]/.test(control)) {
      return { end: index + 3, sig: source.slice(index, index + 3) };
    }
  }
  if (next >= "0" && next <= "9") {
    return readNumericEscapeAtom(source, index, options);
  }
  return { end: index + 2, sig: source.slice(index, index + 2) };
}

function escapeLanguage(
  sig: string,
  foldCase: boolean,
  inClass = false,
  unicode = false,
  capturingGroups = 0,
): AtomLanguage {
  const body = sig.slice(1);
  if (body === "d") {
    return { kind: "chars", chars: new Set(DIGITS) };
  }
  if (body === "D") {
    return { kind: "complement", chars: new Set(DIGITS) };
  }
  if (body === "w") {
    return { kind: "chars", chars: foldedChars(WORD, foldCase) };
  }
  if (body === "W") {
    return { kind: "complement", chars: foldedChars(WORD, foldCase) };
  }
  if (body === "s") {
    return { kind: "chars", chars: new Set(WHITESPACE) };
  }
  if (body === "S") {
    return { kind: "complement", chars: new Set(WHITESPACE) };
  }
  if (body === "n") {
    return singleton("\n", false);
  }
  if (body === "t") {
    return singleton("\t", false);
  }
  if (body === "r") {
    return singleton("\r", false);
  }
  if (body === "f") {
    return singleton("\f", false);
  }
  if (body === "v") {
    return singleton("\v", false);
  }
  if (/^[0-9]+$/.test(body)) {
    const classified = classifyNumericEscape(body, { unicode, capturingGroups, inClass });
    if (classified.kind === "octal" && classified.char !== undefined) {
      return singleton(classified.char, foldCase);
    }
    return { kind: "any" };
  }
  if (body.startsWith("x") && body.length === 3) {
    const ch = parseHexChar(body.slice(1));
    return ch ? singleton(ch, foldCase) : { kind: "any" };
  }
  if (body.startsWith("u") && body.length === 5) {
    const ch = parseHexChar(body.slice(1));
    return ch ? singleton(ch, foldCase) : { kind: "any" };
  }
  if (body.startsWith("u{") && body.endsWith("}")) {
    const ch = parseHexChar(body.slice(2, -1));
    return ch ? singleton(ch, foldCase) : { kind: "any" };
  }
  if (body.startsWith("p") || body.startsWith("P")) {
    return { kind: "any" };
  }
  if (body === "b") {
    return inClass ? singleton("\b", false) : { kind: "any" };
  }
  if (body === "B") {
    return inClass ? singleton("B", foldCase) : { kind: "any" };
  }
  if (body.startsWith("k")) {
    return { kind: "any" };
  }
  if (body.length === 2 && body[0] === "c" && /[A-Za-z]/.test(body[1] ?? "")) {
    return singleton(String.fromCharCode((body.charCodeAt(1) ?? 0) % 32), false);
  }
  if (body.length === 1) {
    return singleton(body, foldCase);
  }
  return { kind: "any" };
}

function singleChar(lang: AtomLanguage): string | null {
  if (lang.kind !== "chars" || lang.chars.size !== 1) {
    return null;
  }
  return lang.chars.values().next().value ?? null;
}

function readClassAtom(
  source: string,
  index: number,
  end: number,
  foldCase: boolean,
  unicode: boolean,
): { next: number; lang: AtomLanguage } | null {
  if (index >= end) {
    return null;
  }
  if (source[index] !== "\\") {
    return { next: index + 1, lang: singleton(source[index] ?? "", foldCase) };
  }
  if (index + 1 >= end) {
    return { next: index + 1, lang: singleton("\\", foldCase) };
  }
  const esc = readCompleteEscapeAtom(source, index, { unicode });
  if (esc.end > end) {
    return {
      next: index + 2,
      lang: escapeLanguage(source.slice(index, index + 2), foldCase, true, unicode),
    };
  }
  return { next: esc.end, lang: escapeLanguage(esc.sig, foldCase, true, unicode) };
}

function classLanguage(sig: string, foldCase: boolean, unicode = false): AtomLanguage {
  if (!sig.startsWith("[") || !sig.endsWith("]")) {
    return { kind: "any" };
  }
  const end = sig.length - 1;
  let i = 1;
  let negated = false;
  if (sig[i] === "^") {
    negated = true;
    i += 1;
  }
  const chars = new Set<string>();
  while (i < end) {
    const left = readClassAtom(sig, i, end, foldCase, unicode);
    if (!left) {
      break;
    }
    if (sig[left.next] === "-" && left.next + 1 < end && sig[left.next + 1] !== "]") {
      const right = readClassAtom(sig, left.next + 1, end, foldCase, unicode);
      const from = singleChar(left.lang);
      const to = right ? singleChar(right.lang) : null;
      if (!right || from === null || to === null || from > to) {
        return { kind: "any" };
      }
      for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code += 1) {
        chars.add(String.fromCharCode(code));
      }
      i = right.next;
      continue;
    }
    if (left.lang.kind !== "chars") {
      return { kind: "any" };
    }
    for (const ch of left.lang.chars) {
      chars.add(ch);
    }
    i = left.next;
  }
  const folded = foldedChars(chars, foldCase);
  return negated ? { kind: "complement", chars: folded } : { kind: "chars", chars: folded };
}

function isAssertionGroup(sig: string): boolean {
  return (
    sig.startsWith("(?=") ||
    sig.startsWith("(?!") ||
    sig.startsWith("(?<=") ||
    sig.startsWith("(?<!")
  );
}

function unwrapSimpleGroup(sig: string): string {
  let current = sig;
  while (current.startsWith("(") && current.endsWith(")")) {
    if (isAssertionGroup(current)) {
      break;
    }
    let inner = current.slice(1, -1);
    if (inner.startsWith("?:")) {
      inner = inner.slice(2);
    }
    if (/[|*+?{(]/.test(inner)) {
      break;
    }
    current = inner;
  }
  return current;
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

function readGroupSig(source: string, index: number): { end: number; sig: string } {
  let depth = 1;
  let i = index + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "[") {
      i = readCharClassSig(source, i).end;
      continue;
    }
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return { end: i, sig: source.slice(index, i) };
}

function stripOuterGroup(sig: string): string | null {
  if (!sig.startsWith("(") || !sig.endsWith(")")) {
    return null;
  }
  let inner = sig.slice(1, -1);
  if (inner.startsWith("?:") || inner.startsWith("?=") || inner.startsWith("?!")) {
    inner = inner.slice(2);
  } else if (inner.startsWith("?<=") || inner.startsWith("?<!")) {
    inner = inner.slice(3);
  } else if (inner.startsWith("?<")) {
    const nameEnd = inner.indexOf(">");
    if (nameEnd === -1) {
      return null;
    }
    inner = inner.slice(nameEnd + 1);
  } else if (inner.startsWith("?")) {
    let i = 1;
    while (i < inner.length && /[a-zA-Z-]/.test(inner[i] ?? "")) {
      i += 1;
    }
    if (inner[i] !== ":") {
      return null;
    }
    inner = inner.slice(i + 1);
  }
  return inner;
}

function splitTopLevelAlternatives(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = readCharClassSig(source, i).end - 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      continue;
    }
    if (ch === "|" && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function firstAtomSig(source: string, unicode: boolean): string {
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      const group = readGroupSig(source, i);
      if (isAssertionGroup(source.slice(i))) {
        i = group.end;
        continue;
      }
      return group.sig;
    }
    if (ch === "\\") {
      return readCompleteEscapeAtom(source, i, { unicode }).sig;
    }
    if (ch === "[") {
      return readCharClassSig(source, i).sig;
    }
    return ch ?? "";
  }
  return "";
}

function emptyLanguage(): AtomLanguage {
  return { kind: "chars", chars: new Set() };
}

const MAX_SEQUENCE_SET = 32;

export const UNKNOWN_LENGTH_ATOM = "\0*";

export function sequenceHasUnknownLength(seq: readonly string[]): boolean {
  return seq.includes(UNKNOWN_LENGTH_ATOM);
}

function unknownSequence(): AtomLanguage[] {
  return [{ kind: "any" }];
}

function unknownSequences(): AtomLanguage[][] {
  return [unknownSequence()];
}

function cartesianConcat(left: AtomLanguage[][], right: AtomLanguage[][]): AtomLanguage[][] {
  if (right.length === 0) {
    return left;
  }
  if (left.length === 0) {
    return right.map((seq) => [...seq]);
  }
  const out: AtomLanguage[][] = [];
  for (const prefix of left) {
    for (const suffix of right) {
      out.push([...prefix, ...suffix]);
      if (out.length > MAX_SEQUENCE_SET) {
        return unknownSequences();
      }
    }
  }
  return out;
}

function sequencesFromSource(
  source: string,
  foldCase: boolean,
  depth: number,
  unicode: boolean,
  capturingGroups: number,
): AtomLanguage[][] {
  let seqs: AtomLanguage[][] = [[]];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{" || ch === "|") {
      return unknownSequences();
    }
    let atomEnd = i + 1;
    let additions: AtomLanguage[][];
    if (ch === "(") {
      const group = readGroupSig(source, i);
      atomEnd = group.end;
      if (isAssertionGroup(source.slice(i))) {
        i = atomEnd;
        continue;
      }
      additions = collectSequences(group.sig, foldCase, depth + 1, unicode, capturingGroups);
    } else if (ch === "\\") {
      const esc = readCompleteEscapeAtom(source, i, { unicode, capturingGroups });
      atomEnd = esc.end;
      additions = [[escapeLanguage(esc.sig, foldCase, false, unicode, capturingGroups)]];
    } else if (ch === "[") {
      const cls = readCharClassSig(source, i);
      atomEnd = cls.end;
      additions = [[classLanguage(cls.sig, foldCase, unicode)]];
    } else if (ch === ".") {
      additions = unknownSequences();
    } else {
      additions = [[singleton(ch ?? "", foldCase)]];
    }
    const next = source[atomEnd];
    if (next === "*" || next === "+" || next === "?" || next === "{") {
      return unknownSequences();
    }
    seqs = cartesianConcat(seqs, additions);
    i = atomEnd;
  }
  return seqs;
}

function collectSequences(
  sig: string,
  foldCase: boolean,
  depth: number,
  unicode: boolean,
  capturingGroups: number,
): AtomLanguage[][] {
  if (depth > 4) {
    return unknownSequences();
  }
  if (isAssertionGroup(sig)) {
    return [[]];
  }
  const inner = stripOuterGroup(sig);
  if (inner !== null) {
    return splitTopLevelAlternatives(inner).flatMap((alternative) => {
      const seqs = sequencesFromSource(alternative, foldCase, depth, unicode, capturingGroups);
      return seqs.map((seq) => (seq.length > 0 ? seq : unknownSequence()));
    });
  }
  if (sig.startsWith("[")) {
    return [[classLanguage(sig, foldCase, unicode)]];
  }
  if (sig.startsWith("\\")) {
    const esc = readCompleteEscapeAtom(sig, 0, { unicode, capturingGroups });
    return [[escapeLanguage(esc.sig, foldCase, false, unicode, capturingGroups)]];
  }
  if (!sig || sig === ".") {
    return unknownSequences();
  }
  if (sig.length === 1) {
    return [[singleton(sig, foldCase)]];
  }
  const seqs = sequencesFromSource(sig, foldCase, depth, unicode, capturingGroups);
  return seqs.map((seq) => (seq.length > 0 ? seq : unknownSequence()));
}

function sequencesOverlap(left: readonly AtomLanguage[], right: readonly AtomLanguage[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i += 1) {
    const leftLang = left[i];
    const rightLang = right[i];
    if (!leftLang || !rightLang || !languagesOverlap(leftLang, rightLang)) {
      return false;
    }
  }
  return true;
}

function sequenceSetsOverlap(
  left: readonly AtomLanguage[][],
  right: readonly AtomLanguage[][],
): boolean {
  for (const leftSeq of left) {
    for (const rightSeq of right) {
      if (sequencesOverlap(leftSeq, rightSeq)) {
        return true;
      }
    }
  }
  return false;
}

function unionLanguages(left: AtomLanguage, right: AtomLanguage): AtomLanguage {
  if (left.kind === "any" || right.kind === "any") {
    return { kind: "any" };
  }
  if (left.kind === "chars" && right.kind === "chars") {
    const chars = new Set(left.chars);
    for (const ch of right.chars) {
      chars.add(ch);
    }
    return { kind: "chars", chars };
  }
  return { kind: "any" };
}

function groupPrefixLanguage(
  sig: string,
  foldCase: boolean,
  depth: number,
  unicode: boolean,
  capturingGroups: number,
): AtomLanguage {
  if (depth > 4) {
    return { kind: "any" };
  }
  if (isAssertionGroup(sig)) {
    return emptyLanguage();
  }
  const inner = stripOuterGroup(sig);
  if (inner === null) {
    return { kind: "any" };
  }
  const alternatives = splitTopLevelAlternatives(inner);
  let union: AtomLanguage | null = null;
  for (const alternative of alternatives) {
    const first = firstAtomSig(alternative, unicode);
    const lang = atomLanguageAtDepth(first, foldCase, depth + 1, unicode, capturingGroups);
    union = union ? unionLanguages(union, lang) : lang;
    if (union.kind === "any") {
      return union;
    }
  }
  return union ?? { kind: "any" };
}

function atomLanguageAtDepth(
  sig: string,
  foldCase: boolean,
  depth: number,
  unicode: boolean,
  capturingGroups: number,
): AtomLanguage {
  const atom = unwrapSimpleGroup(sig);
  if (!atom || atom === "." || atom === UNKNOWN_LENGTH_ATOM) {
    return { kind: "any" };
  }
  if (isAssertionGroup(atom)) {
    return emptyLanguage();
  }
  if (atom.startsWith("(")) {
    return groupPrefixLanguage(atom, foldCase, depth, unicode, capturingGroups);
  }
  if (atom.startsWith("[")) {
    return classLanguage(atom, foldCase, unicode);
  }
  if (atom.startsWith("\\")) {
    const esc = readCompleteEscapeAtom(atom, 0, { unicode, capturingGroups });
    return escapeLanguage(esc.sig, foldCase, false, unicode, capturingGroups);
  }
  if (atom.length === 1) {
    return singleton(atom, foldCase);
  }
  return singleton(atom[0] ?? "", foldCase);
}

function languagesOverlap(left: AtomLanguage, right: AtomLanguage): boolean {
  if (left.kind === "any" || right.kind === "any") {
    return true;
  }
  if (left.kind === "chars" && right.kind === "chars") {
    for (const ch of left.chars) {
      if (right.chars.has(ch)) {
        return true;
      }
    }
    return false;
  }
  if (left.kind === "chars" && right.kind === "complement") {
    for (const ch of left.chars) {
      if (!right.chars.has(ch)) {
        return true;
      }
    }
    return false;
  }
  if (left.kind === "complement" && right.kind === "chars") {
    return languagesOverlap(right, left);
  }
  return true;
}

export function atomsCanMatchSamePrefix(
  left: string,
  right: string,
  foldCase = false,
  unicode = false,
  capturingGroups = 0,
): boolean {
  if (left === right || !left || !right) {
    return true;
  }
  return sequenceSetsOverlap(
    collectSequences(left, foldCase, 0, unicode, capturingGroups),
    collectSequences(right, foldCase, 0, unicode, capturingGroups),
  );
}

function atomSigSequencesOverlap(
  left: readonly string[],
  right: readonly string[],
  foldCase: boolean,
  unicode: boolean,
  capturingGroups: number,
): boolean {
  if (left.length === 0 || right.length === 0) {
    return true;
  }
  if (sequenceHasUnknownLength(left) || sequenceHasUnknownLength(right)) {
    return true;
  }
  const leftLangs = left.map((sig) =>
    atomLanguageAtDepth(sig, foldCase, 0, unicode, capturingGroups),
  );
  const rightLangs = right.map((sig) =>
    atomLanguageAtDepth(sig, foldCase, 0, unicode, capturingGroups),
  );
  return sequencesOverlap(leftLangs, rightLangs);
}

export function alternativeSequencesOverlap(
  sequences: readonly (readonly string[])[],
  foldCase = false,
  unicode = false,
  capturingGroups = 0,
): boolean {
  if (sequences.length < 2) {
    return false;
  }
  for (let i = 0; i < sequences.length; i += 1) {
    const left = sequences[i];
    if (left === undefined) {
      continue;
    }
    for (let j = i + 1; j < sequences.length; j += 1) {
      const right = sequences[j];
      if (right === undefined) {
        continue;
      }
      if (atomSigSequencesOverlap(left, right, foldCase, unicode, capturingGroups)) {
        return true;
      }
    }
  }
  return false;
}
