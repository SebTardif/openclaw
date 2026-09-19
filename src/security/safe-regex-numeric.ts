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
