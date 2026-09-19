// Classifies decimal and octal regex escapes using capture and flag context.

type NumericEscapeKind = "backref" | "octal" | "unknown";

type NumericEscapeClass = {
  kind: NumericEscapeKind;
  char?: string;
};

export function classifyNumericEscape(
  body: string,
  options: {
    unicode?: boolean;
    capturingGroups?: number;
    inClass?: boolean;
  } = {},
): NumericEscapeClass {
  if (!/^[0-9]+$/.test(body)) {
    return { kind: "unknown" };
  }
  const unicode = options.unicode === true;
  const inClass = options.inClass === true;
  const capturingGroups = options.capturingGroups ?? 0;
  if (unicode) {
    if (body === "0") {
      return { kind: "octal", char: "\0" };
    }
    if (body.startsWith("0")) {
      return { kind: "unknown" };
    }
    return { kind: "backref" };
  }
  const decimal = Number.parseInt(body, 10);
  const canBeBackref = !inClass && body[0] !== "0" && decimal >= 1 && decimal <= capturingGroups;
  if (canBeBackref) {
    return { kind: "backref" };
  }
  if (/^[0-7]+$/.test(body)) {
    const value = Number.parseInt(body, 8);
    if (value <= 0xff) {
      return { kind: "octal", char: String.fromCharCode(value) };
    }
  }
  return { kind: "unknown" };
}

export function escapeHasUnknownConsumedLength(
  sig: string,
  options: { unicode?: boolean; capturingGroups?: number } = {},
): boolean {
  if (!sig.startsWith("\\")) {
    return false;
  }
  const body = sig.slice(1);
  if (body.startsWith("k<")) {
    return true;
  }
  if (!/^[0-9]+$/.test(body)) {
    return false;
  }
  return classifyNumericEscape(body, options).kind === "backref";
}

export function isZeroWidthAssertionEscape(sig: string): boolean {
  return sig === "\\b" || sig === "\\B";
}

function readLegacyOctalEnd(source: string, index: number): number {
  const first = source[index + 1];
  if (first === undefined || first < "0" || first > "7") {
    return index + 1;
  }
  const maxDigits = first <= "3" ? 3 : 2;
  let end = index + 2;
  let taken = 1;
  while (taken < maxDigits && end < source.length) {
    const digit = source[end];
    if (digit === undefined || digit < "0" || digit > "7") {
      break;
    }
    end += 1;
    taken += 1;
  }
  return end;
}

export function readNumericEscapeAtom(
  source: string,
  index: number,
  options: { unicode?: boolean; capturingGroups?: number } = {},
): { end: number; sig: string } {
  if (source[index] !== "\\") {
    return { end: index + 1, sig: source[index] ?? "" };
  }
  const next = source[index + 1];
  if (next === undefined || next < "0" || next > "9") {
    return { end: index + 2, sig: source.slice(index, index + 2) };
  }
  let end = index + 2;
  while (end < source.length) {
    const digit = source[end];
    if (digit === undefined || digit < "0" || digit > "9") {
      break;
    }
    end += 1;
  }
  const fullSig = source.slice(index, end);
  if (options.unicode === true) {
    return { end, sig: fullSig };
  }
  const classified = classifyNumericEscape(fullSig.slice(1), {
    unicode: false,
    capturingGroups: options.capturingGroups,
  });
  if (classified.kind === "backref") {
    return { end, sig: fullSig };
  }
  const octalEnd = readLegacyOctalEnd(source, index);
  if (octalEnd > index + 1) {
    return { end: octalEnd, sig: source.slice(index, octalEnd) };
  }
  return { end: index + 2, sig: source.slice(index, index + 2) };
}
