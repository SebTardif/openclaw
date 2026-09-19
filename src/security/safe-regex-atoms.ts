// Compares regex atom languages for schema-pattern ReDoS screening.

const DIGITS = "0123456789";
const WORD = `${DIGITS}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_`;
const WHITESPACE = " \t\n\r\f\v";

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

function escapeLanguage(sig: string, foldCase: boolean): AtomLanguage {
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
  return { next: index + 2, lang: escapeLanguage(source.slice(index, index + 2), foldCase) };
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

function unwrapSimpleGroup(sig: string): string {
  let current = sig;
  while (current.startsWith("(") && current.endsWith(")")) {
    let inner = current.slice(1, -1);
    if (inner.startsWith("?:") || inner.startsWith("?=") || inner.startsWith("?!")) {
      inner = inner.slice(2);
    }
    if (/[|*+?{(]/.test(inner)) {
      break;
    }
    current = inner;
  }
  return current;
}

function atomLanguage(sig: string, foldCase: boolean): AtomLanguage {
  const atom = unwrapSimpleGroup(sig);
  if (!atom || atom === ".") {
    return { kind: "any" };
  }
  if (atom.startsWith("[")) {
    return classLanguage(atom, foldCase);
  }
  if (atom.startsWith("\\")) {
    return escapeLanguage(atom, foldCase);
  }
  if (atom.length === 1) {
    return singleton(atom, foldCase);
  }
  return { kind: "any" };
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
  return languagesOverlap(atomLanguage(left, foldCase), atomLanguage(right, foldCase));
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
