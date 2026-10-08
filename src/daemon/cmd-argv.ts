import { splitArgsPreservingQuotes } from "./arg-split.js";
import { assertNoCmdLineBreak } from "./cmd-set.js";

export function quoteCmdScriptArg(
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string {
  assertNoCmdLineBreak(value, "Command argument");
  if (!value) {
    return '""';
  }
  const quoted = value.replace(/"/g, '\\"').replace(/%/g, "%%");
  const escaped = options.delayedExpansion === false ? quoted : quoted.replace(/!/g, "^!");
  if (!/[ \t"&|<>^()%!]/g.test(value)) {
    return escaped;
  }
  // A trailing backslash would otherwise escape the wrapper quote (`\"`).
  return `"${escaped.replace(/(\\+)$/, (slashes) => slashes + slashes)}"`;
}

function decodeCmdScriptLiterals(value: string): string {
  return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}

function unescapeInsertedCmdQuotes(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] === '"') {
      decoded += '"';
      index += 1;
      continue;
    }
    decoded += value[index] ?? "";
  }
  return decoded;
}

export function parseCmdScriptCommandLine(value: string): string[] {
  // Script renderer escapes quotes (`\"`) and cmd expansions (`%%`, `^!`).
  // Keep all other backslashes literal so Windows drive/UNC paths survive.
  // A doubled trailing-backslash run escapes the closer; halve that run.
  // A quote that still has its own closer is content, not that run.
  const args: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index] ?? "")) {
      index += 1;
    }
    if (index >= value.length) {
      break;
    }
    if (value[index] !== '"') {
      const start = index;
      while (index < value.length && !/\s/.test(value[index] ?? "")) {
        index += 1;
      }
      args.push(decodeCmdScriptLiterals(value.slice(start, index)));
      continue;
    }
    const start = index;
    let cursor = index + 1;
    let closed = false;
    while (cursor < value.length) {
      if (value[cursor] === "\\" && value[cursor + 1] === '"') {
        cursor += 2;
        continue;
      }
      if (value[cursor] === '"') {
        cursor += 1;
        closed = true;
        break;
      }
      cursor += 1;
    }
    const token = value.slice(start, cursor);
    index = cursor;
    if (closed) {
      args.push(
        ...splitArgsPreservingQuotes(token, { escapeMode: "backslash-quote-only" }).map(
          decodeCmdScriptLiterals,
        ),
      );
      continue;
    }
    const inner = token.endsWith('"') ? token.slice(1, -1) : token.slice(1);
    const tail = /^(.*?)(\\*)$/u.exec(inner);
    const body = tail?.[1] ?? "";
    const slashes = tail?.[2] ?? "";
    const kept =
      slashes.length > 0 && slashes.length % 2 === 0
        ? `${body}${"\\".repeat(slashes.length / 2)}`
        : inner;
    args.push(decodeCmdScriptLiterals(unescapeInsertedCmdQuotes(kept)));
  }
  return args;
}

export function stripTrailingCmdRedirections(commandLine: string): string | null {
  const tokens: { start: number; end: number; redirect?: string }[] = [];
  // Validate the entire command before removing anything. A compound command or
  // uncertain cmd/argv quote boundary must never become exact process-ownership proof.
  for (let index = 0; index < commandLine.length;) {
    if (/[ \t]/.test(commandLine.charAt(index))) {
      index++;
      continue;
    }
    let start = index;
    const operator = commandLine[index];
    if (operator === ">" || operator === "<") {
      const previous = tokens.at(-1);
      if (previous && !previous.redirect && previous.end === index) {
        const word = commandLine.slice(previous.start, previous.end);
        if (/\d$/.test(word)) {
          // A digit attached to an argument can instead be cmd's handle number.
          // Do not guess which bytes of that argument belong to the process.
          if (!/^\d$/.test(word)) {
            return null;
          }
          start = previous.start;
          tokens.pop();
        }
      }
      index++;
      let redirect: "<" | ">" | ">>" | ">&" = operator;
      if (operator === ">" && commandLine[index] === ">") {
        redirect = ">>";
        index++;
      }
      if (redirect === ">" && commandLine[index] === "&") {
        if (!/[0-9]/.test(commandLine[index + 1] ?? "")) {
          return null;
        }
        redirect = ">&";
        index += 2;
      }
      tokens.push({ start, end: index, redirect });
      continue;
    }
    let quoted = false;
    while (index < commandLine.length) {
      const char = commandLine.charAt(index);
      if (
        char === "\r" ||
        char === "\n" ||
        (char === "\\" && commandLine[index + 1] === '"') ||
        (char === "^" && (!quoted || commandLine[index + 1] === '"'))
      ) {
        return null;
      }
      if (char === '"') {
        quoted = !quoted;
      } else if (!quoted) {
        if ("&|()".includes(char)) {
          return null;
        }
        if (/[ \t<>]/.test(char)) {
          break;
        }
      }
      index++;
    }
    if (quoted) {
      return null;
    }
    tokens.push({ start, end: index });
  }

  const firstRedirect = tokens.findIndex((token) => token.redirect !== undefined);
  const firstToken = tokens[firstRedirect];
  if (!firstToken) {
    return commandLine;
  }
  for (let index = firstRedirect; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token?.redirect) {
      return null;
    }
    if (token.redirect === ">&") {
      continue;
    }
    const target = tokens[++index];
    if (!target || target.redirect) {
      return null;
    }
    const value = commandLine.slice(target.start, target.end);
    // Unquoted expansions can introduce filename delimiters and leave extra argv.
    if (
      (value.includes('"') && !/^"[^"]+"$/.test(value)) ||
      (!value.includes('"') && /[,;=%!]/.test(value)) ||
      (token.redirect === "<" && !/^(?:NUL|"NUL")$/i.test(value))
    ) {
      return null;
    }
  }
  // Redirection alone has no executable for the service reader to inspect.
  return commandLine.slice(0, firstToken.start);
}
