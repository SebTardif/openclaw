import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

describe("custom adjacent-class redaction", () => {
  it("keeps custom adjacent-class redaction patterns active", () => {
    const secret = "corp-ABCDEFGHIJKLMNOP";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["corp-[A-Z]+[A-Z]+"],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });

  it("keeps disjoint escaped custom redaction alternatives active", () => {
    const secret = "corp-ABCD";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["corp-(\\x41|BCD)+"],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });
});
