// Finite atom-sequence expansion for alternative overlap analysis.

export type AtomSequence = {
  atoms: string[];
  complete: boolean;
  nextAtom?: string;
  unknownTail?: boolean;
};

export function sequenceAtomsForOverlap(seq: AtomSequence): string[] {
  return seq.nextAtom === undefined ? seq.atoms : [...seq.atoms, seq.nextAtom];
}

function withNextAtom(
  atoms: string[],
  complete: boolean,
  nextAtom: string | undefined,
  unknownTail = false,
): AtomSequence {
  const seq: AtomSequence = { atoms, complete };
  if (!complete && nextAtom !== undefined) {
    seq.nextAtom = nextAtom;
  }
  if (!complete && unknownTail) {
    seq.unknownTail = true;
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
  return withNextAtom([...seq.atoms], seq.complete, seq.nextAtom, seq.unknownTail === true);
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
    return withNextAtom(kept, false, prefix.nextAtom, true);
  }
  const fromSuffix = room < suffix.atoms.length;
  return withNextAtom(
    kept,
    false,
    fromSuffix ? suffix.atoms[room] : suffix.nextAtom,
    suffix.unknownTail === true ||
      (fromSuffix && (!suffix.complete || suffix.atoms.length - room > 1)),
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
