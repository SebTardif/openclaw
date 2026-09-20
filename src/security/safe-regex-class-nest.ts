export function classBodyHasNestedSet(sig: string, start: number, end: number): boolean {
  let seenOpen = false;
  for (let i = start; i < end; i += 1) {
    if (sig[i] === "\\") {
      i += 1;
      continue;
    }
    if (sig[i] === "[") {
      seenOpen = true;
      continue;
    }
    if (seenOpen && sig[i] === "]") {
      return true;
    }
  }
  return false;
}
