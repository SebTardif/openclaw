const MAX_BROWSER_URL_PATTERN_LENGTH = 512;

type UrlPatternToken = { kind: "lit"; text: string } | { kind: "star" } | { kind: "glob" };

function tokenizeBrowserUrlPattern(pattern: string): UrlPatternToken[] {
  const tokens: UrlPatternToken[] = [];
  let literal = "";
  const flush = () => {
    if (!literal) {
      return;
    }
    tokens.push({ kind: "lit", text: literal });
    literal = "";
  };
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char !== "*") {
      literal += char;
      continue;
    }
    flush();
    if (pattern[index + 1] === "*") {
      tokens.push({ kind: "glob" });
      index += 1;
      continue;
    }
    tokens.push({ kind: "star" });
  }
  flush();
  return tokens;
}

// `*` is one path segment. `**` may cross slashes. Matching is a linear scan
// so a tool pattern cannot stall the Node event loop.
function matchBrowserUrlWildcard(pattern: string, url: string): boolean {
  const tokens = tokenizeBrowserUrlPattern(pattern);
  let positions = new Set<number>([0]);
  for (const token of tokens) {
    const next = new Set<number>();
    if (token.kind === "lit") {
      for (const pos of positions) {
        if (url.startsWith(token.text, pos)) {
          next.add(pos + token.text.length);
        }
      }
    } else if (token.kind === "star") {
      for (const pos of positions) {
        next.add(pos);
        for (let index = pos; index < url.length && url[index] !== "/"; index += 1) {
          next.add(index + 1);
        }
      }
    } else {
      let start = url.length + 1;
      for (const pos of positions) {
        if (pos < start) {
          start = pos;
        }
      }
      for (let index = start; index <= url.length; index += 1) {
        next.add(index);
      }
    }
    if (next.size === 0) {
      return false;
    }
    positions = next;
  }
  return positions.has(url.length);
}

export function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  const trimmedPattern = pattern.trim();
  if (!trimmedPattern) {
    return false;
  }
  if (trimmedPattern === url || trimmedPattern === "*") {
    return true;
  }
  if (trimmedPattern.includes("*")) {
    if (trimmedPattern.length > MAX_BROWSER_URL_PATTERN_LENGTH) {
      return false;
    }
    return matchBrowserUrlWildcard(trimmedPattern, url);
  }
  return url.includes(trimmedPattern);
}
