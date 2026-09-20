// Finite atom-sequence expansion for alternative overlap analysis.

export type AtomSequence = {
  atoms: string[];
  complete: boolean;
  nextAtom?: string;
  unknownTail?: boolean;
  /** Omitted tail is more copies of nextAtom (34 vs 68 `a`s), not a later distinct suffix. */
  unknownTailHomogeneous?: boolean;
};

export function sequenceAtomsForOverlap(seq: AtomSequence): string[] {
  return seq.nextAtom === undefined ? seq.atoms : [...seq.atoms, seq.nextAtom];
}

function withNextAtom(
  atoms: string[],
  complete: boolean,
  nextAtom: string | undefined,
  unknownTail = false,
  unknownTailHomogeneous = false,
): AtomSequence {
  const seq: AtomSequence = { atoms, complete };
  if (!complete && nextAtom !== undefined) {
    seq.nextAtom = nextAtom;
  }
  if (!complete && unknownTail) {
    seq.unknownTail = true;
    if (unknownTailHomogeneous) {
      seq.unknownTailHomogeneous = true;
    }
  }
  return seq;
}

/** Truncated equal prefixes prove overlap only if one language is fully witnessed. */
export function sequenceOverlapIsProven(leftSeq: AtomSequence, rightSeq: AtomSequence): boolean {
  if (leftSeq.atoms.length < rightSeq.atoms.length) {
    return leftSeq.complete;
  }
  if (rightSeq.atoms.length < leftSeq.atoms.length) {
    return rightSeq.complete;
  }
  if (leftSeq.complete || rightSeq.complete) {
    return true;
  }
  if (leftSeq.unknownTail === true && rightSeq.unknownTail === true) {
    return false;
  }
  return leftSeq.nextAtom !== undefined && rightSeq.nextAtom !== undefined;
}

export const ATOM_SEQUENCE_OVERFLOW = "overflow";

export type AtomSequenceRead = AtomSequence[] | typeof ATOM_SEQUENCE_OVERFLOW | null;

export const MAX_ALTERNATIVE_SEQUENCES = 16;
const MAX_SEQUENCE_ATOMS = 32;

function cloneAtomSequence(seq: AtomSequence): AtomSequence {
  return withNextAtom(
    [...seq.atoms],
    seq.complete,
    seq.nextAtom,
    seq.unknownTail === true,
    seq.unknownTailHomogeneous === true,
  );
}

function omittedTailIsHomogeneous(suffix: AtomSequence, room: number): boolean {
  const next = suffix.atoms[room];
  if (next === undefined) {
    return false;
  }
  if (suffix.unknownTail === true) {
    return false;
  }
  if (suffix.nextAtom !== undefined && suffix.nextAtom !== next) {
    return false;
  }
  return suffix.atoms.slice(room + 1).every((atom) => atom === next);
}

/** Collapse ax|bx|…|qx into one (?:a|b|…|q)x sequence when tails match. */
function collapseEqualTailSequences(sequences: readonly AtomSequence[]): AtomSequence[] | null {
  if (sequences.length < 2) {
    return null;
  }
  const first = sequences[0];
  if (!first?.complete || first.atoms.length < 2 || first.unknownTail === true) {
    return null;
  }
  const tail = first.atoms.slice(1);
  const tailKey = tail.join("\0");
  const heads: string[] = [];
  for (const seq of sequences) {
    if (
      !seq.complete ||
      seq.unknownTail === true ||
      seq.atoms.length !== first.atoms.length ||
      seq.atoms.slice(1).join("\0") !== tailKey
    ) {
      return null;
    }
    const head = seq.atoms[0];
    if (head === undefined) {
      return null;
    }
    heads.push(head);
  }
  const firstHead = heads[0];
  if (firstHead === undefined) {
    return null;
  }
  const union = heads.length === 1 ? firstHead : `(?:${heads.join("|")})`;
  return [{ atoms: [union, ...tail], complete: true }];
}

export function appendCollapsedSequences(
  all: AtomSequence[],
  sequences: AtomSequence[],
): typeof ATOM_SEQUENCE_OVERFLOW | null {
  if (all.length + sequences.length <= MAX_ALTERNATIVE_SEQUENCES) {
    all.push(...sequences);
    return null;
  }
  const collapsed = collapseEqualTailSequences([...all, ...sequences]);
  if (!collapsed) {
    return ATOM_SEQUENCE_OVERFLOW;
  }
  all.length = 0;
  all.push(...collapsed);
  return null;
}

function concatAtomSequence(prefix: AtomSequence, suffix: AtomSequence): AtomSequence {
  if (prefix.atoms.length + suffix.atoms.length <= MAX_SEQUENCE_ATOMS) {
    return withNextAtom(
      [...prefix.atoms, ...suffix.atoms],
      prefix.complete && suffix.complete,
      prefix.complete ? suffix.nextAtom : prefix.nextAtom,
      prefix.unknownTail === true ||
        suffix.unknownTail === true ||
        (!prefix.complete && suffix.atoms.length > 0),
    );
  }
  const room = Math.max(0, MAX_SEQUENCE_ATOMS - prefix.atoms.length);
  const kept = room > 0 ? [...prefix.atoms, ...suffix.atoms.slice(0, room)] : [...prefix.atoms];
  if (!prefix.complete) {
    const suffixAtom = suffix.atoms.length === 1 ? suffix.atoms[0] : undefined;
    const sameAsNext =
      prefix.nextAtom !== undefined && suffixAtom !== undefined && suffixAtom === prefix.nextAtom;
    const homogeneous =
      sameAsNext && (prefix.unknownTailHomogeneous === true || prefix.unknownTail !== true);
    return withNextAtom(kept, false, prefix.nextAtom, true, homogeneous);
  }
  const fromSuffix = room < suffix.atoms.length;
  const unknownTail =
    suffix.unknownTail === true ||
    (fromSuffix && (!suffix.complete || suffix.atoms.length - room > 1));
  return withNextAtom(
    kept,
    false,
    fromSuffix ? suffix.atoms[room] : suffix.nextAtom,
    unknownTail,
    unknownTail && fromSuffix && omittedTailIsHomogeneous(suffix, room),
  );
}

export function cartesianConcatSequences(
  left: readonly AtomSequence[],
  right: readonly AtomSequence[],
): AtomSequence[] | typeof ATOM_SEQUENCE_OVERFLOW {
  if (left.length === 0) {
    return right.map(cloneAtomSequence);
  }
  if (right.length === 0) {
    return left.map(cloneAtomSequence);
  }
  if (left.length * right.length > MAX_ALTERNATIVE_SEQUENCES) {
    return ATOM_SEQUENCE_OVERFLOW;
  }
  const out: AtomSequence[] = [];
  for (const prefix of left) {
    for (const suffix of right) {
      out.push(concatAtomSequence(prefix, suffix));
    }
  }
  return out;
}
