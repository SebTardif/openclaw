// Compares regex atom languages for schema-pattern ReDoS screening.

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

export function readCompleteEscapeAtom(
  source: string,
  index: number,
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
  if (next === "u" && source[index + 2] === "{") {
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
  return { end: index + 2, sig: source.slice(index, index + 2) };
}

function escapeLanguage(sig: string, foldCase: boolean, inClass = false): AtomLanguage {
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
  if (body === "0") {
    return singleton("\0", false);
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
  if (/^[1-9]\d*$/.test(body)) {
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
  const nextCh = source[index + 1];
  if (nextCh === "p" || nextCh === "P") {
    if (source[index + 2] === "{") {
      const close = source.indexOf("}", index + 3);
      if (close !== -1 && close < end) {
        return { next: close + 1, lang: { kind: "any" } };
      }
    }
    return { next: index + 2, lang: { kind: "any" } };
  }
  if (nextCh === "u" && source[index + 2] === "{") {
    const close = source.indexOf("}", index + 3);
    if (close !== -1 && close < end) {
      const ch = parseHexChar(source.slice(index + 3, close));
      return { next: close + 1, lang: ch ? singleton(ch, foldCase) : { kind: "any" } };
    }
  }
  if (nextCh === "u" && index + 5 < end) {
    const ch = parseHexChar(source.slice(index + 2, index + 6));
    return { next: index + 6, lang: ch ? singleton(ch, foldCase) : { kind: "any" } };
  }
  if (nextCh === "x" && index + 3 < end) {
    const ch = parseHexChar(source.slice(index + 2, index + 4));
    return { next: index + 4, lang: ch ? singleton(ch, foldCase) : { kind: "any" } };
  }
  return { next: index + 2, lang: escapeLanguage(source.slice(index, index + 2), foldCase, true) };
}

function classLanguage(sig: string, foldCase: boolean): AtomLanguage {
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
    const left = readClassAtom(sig, i, end, foldCase);
    if (!left) {
      break;
    }
    if (sig[left.next] === "-" && left.next + 1 < end && sig[left.next + 1] !== "]") {
      const right = readClassAtom(sig, left.next + 1, end, foldCase);
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

function firstAtomSig(source: string): string {
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
      return readCompleteEscapeAtom(source, i).sig;
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

function sequenceFromSource(source: string, foldCase: boolean, depth: number): AtomLanguage[] {
  const seq: AtomLanguage[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+" || ch === "?" || ch === "{" || ch === "|") {
      return [{ kind: "any" }];
    }
    let atomEnd = i + 1;
    if (ch === "(") {
      const group = readGroupSig(source, i);
      atomEnd = group.end;
      if (isAssertionGroup(source.slice(i))) {
        i = atomEnd;
        continue;
      }
      const nested = collectSequences(group.sig, foldCase, depth + 1);
      const nestedSeq = nested[0];
      if (nested.length === 1 && nestedSeq) {
        seq.push(...nestedSeq);
      } else {
        seq.push(groupPrefixLanguage(group.sig, foldCase, depth + 1));
      }
    } else if (ch === "\\") {
      const esc = readCompleteEscapeAtom(source, i);
      atomEnd = esc.end;
      seq.push(escapeLanguage(esc.sig, foldCase));
    } else if (ch === "[") {
      const cls = readCharClassSig(source, i);
      atomEnd = cls.end;
      seq.push(classLanguage(cls.sig, foldCase));
    } else if (ch === ".") {
      seq.push({ kind: "any" });
    } else {
      seq.push(singleton(ch ?? "", foldCase));
    }
    const next = source[atomEnd];
    if (next === "*" || next === "+" || next === "?" || next === "{") {
      return [{ kind: "any" }];
    }
    i = atomEnd;
  }
  return seq;
}

function collectSequences(sig: string, foldCase: boolean, depth: number): AtomLanguage[][] {
  if (depth > 4) {
    return [[{ kind: "any" }]];
  }
  if (isAssertionGroup(sig)) {
    return [[]];
  }
  const inner = stripOuterGroup(sig);
  if (inner !== null) {
    return splitTopLevelAlternatives(inner).map((alternative) => {
      const seq = sequenceFromSource(alternative, foldCase, depth);
      return seq.length > 0 ? seq : [{ kind: "any" }];
    });
  }
  if (sig.startsWith("[")) {
    return [[classLanguage(sig, foldCase)]];
  }
  if (sig.startsWith("\\")) {
    return [[escapeLanguage(readCompleteEscapeAtom(sig, 0).sig, foldCase)]];
  }
  if (!sig || sig === ".") {
    return [[{ kind: "any" }]];
  }
  if (sig.length === 1) {
    return [[singleton(sig, foldCase)]];
  }
  const seq = sequenceFromSource(sig, foldCase, depth);
  return [seq.length > 0 ? seq : [{ kind: "any" }]];
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

function groupPrefixLanguage(sig: string, foldCase: boolean, depth: number): AtomLanguage {
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
    const first = firstAtomSig(alternative);
    const lang = atomLanguageAtDepth(first, foldCase, depth + 1);
    union = union ? unionLanguages(union, lang) : lang;
    if (union.kind === "any") {
      return union;
    }
  }
  return union ?? { kind: "any" };
}

function atomLanguageAtDepth(sig: string, foldCase: boolean, depth: number): AtomLanguage {
  const atom = unwrapSimpleGroup(sig);
  if (!atom || atom === ".") {
    return { kind: "any" };
  }
  if (isAssertionGroup(atom)) {
    return emptyLanguage();
  }
  if (atom.startsWith("(")) {
    return groupPrefixLanguage(atom, foldCase, depth);
  }
  if (atom.startsWith("[")) {
    return classLanguage(atom, foldCase);
  }
  if (atom.startsWith("\\")) {
    return escapeLanguage(readCompleteEscapeAtom(atom, 0).sig, foldCase);
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

export function atomsCanMatchSamePrefix(left: string, right: string, foldCase = false): boolean {
  if (left === right || !left || !right) {
    return true;
  }
  return sequenceSetsOverlap(
    collectSequences(left, foldCase, 0),
    collectSequences(right, foldCase, 0),
  );
}

export function firstAtomsOverlap(atoms: readonly string[], foldCase = false): boolean {
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
      if (atomsCanMatchSamePrefix(left, right, foldCase)) {
        return true;
      }
    }
  }
  return false;
}
