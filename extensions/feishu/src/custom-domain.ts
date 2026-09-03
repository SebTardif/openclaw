// Feishu custom domains canonicalize operator-configured HTTPS bases for request routing.

/** Flag-free so generated JSON Schema `pattern` rejects http:// and accepts HTTPS://. */
export const FEISHU_CUSTOM_HTTPS_DOMAIN_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]:\/\//;

const FEISHU_NAMED_DOMAIN_PRESETS = new Set(["feishu", "lark"]);

/**
 * Treat feishu/lark as named presets. Custom values become an HTTPS origin+path
 * base (no userinfo, query, fragment, or trailing slash) so request routing
 * does not depend on Zod transforms that generated JSON Schema skips.
 */
export function canonicalizeFeishuDomain(domain: string | undefined): string | undefined {
  if (!domain || FEISHU_NAMED_DOMAIN_PRESETS.has(domain)) {
    return domain;
  }
  try {
    const parsed = new URL(domain);
    parsed.protocol = "https:";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}
