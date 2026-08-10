/** models.json plaintext / unresolved-ref collection for secrets audit. */
import fs from "node:fs";
import {
  isNonSecretApiKeyMarker,
  isSecretRefHeaderValueMarker,
} from "../agents/model-auth-markers.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { isLikelySensitiveModelProviderHeaderName } from "./model-provider-header-policy.js";
import { isNonEmptyString, isRecord } from "./shared.js";
import { readJsonObjectIfExists } from "./storage-scan.js";

type ModelsJsonAuditFinding = {
  code: "PLAINTEXT_FOUND" | "REF_UNRESOLVED";
  severity: "warn" | "error";
  file: string;
  jsonPath: string;
  message: string;
  provider?: string;
};

type ConfigRefAssignment = {
  path: string;
  ref: SecretRef;
  provider?: string;
};

/**
 * models.json persists env SecretRefs as bare env-name markers (for example
 * "FACTCHAT_API_KEY"), not only the built-in known-marker list. Accept those
 * only when the live config owns the same provider with an env SecretRef whose
 * id equals the marker. Arbitrary all-caps strings stay PLAINTEXT.
 */
function isConfigOwnedEnvApiKeyMarker(params: {
  providerId: string;
  marker: string;
  refAssignments: readonly ConfigRefAssignment[];
}): boolean {
  const marker = params.marker.trim();
  if (!marker) {
    return false;
  }
  const providerKey = normalizeProviderId(params.providerId);
  for (const assignment of params.refAssignments) {
    if (!assignment.provider) {
      continue;
    }
    if (normalizeProviderId(assignment.provider) !== providerKey) {
      continue;
    }
    // Match provider apiKey targets only (not header or other secret paths).
    if (!assignment.path.endsWith(".apiKey")) {
      continue;
    }
    if (assignment.ref.source !== "env") {
      continue;
    }
    if (assignment.ref.id.trim() === marker) {
      return true;
    }
  }
  return false;
}

/** Collect models.json findings for plaintext credentials and unresolved SecretRef objects. */
export function collectModelsJsonSecrets(params: {
  modelsJsonPath: string;
  maxBytes: number;
  filesScanned: Set<string>;
  refAssignments: readonly ConfigRefAssignment[];
  addFinding: (finding: ModelsJsonAuditFinding) => void;
}): void {
  if (!fs.existsSync(params.modelsJsonPath)) {
    return;
  }
  params.filesScanned.add(params.modelsJsonPath);
  const parsedResult = readJsonObjectIfExists(params.modelsJsonPath, {
    requireRegularFile: true,
    maxBytes: params.maxBytes,
  });
  if (parsedResult.error) {
    params.addFinding({
      code: "REF_UNRESOLVED",
      severity: "error",
      file: params.modelsJsonPath,
      jsonPath: "<root>",
      message: `Invalid JSON in models.json: ${parsedResult.error}`,
    });
    return;
  }
  const parsed = parsedResult.value;
  if (!parsed || !isRecord(parsed.providers)) {
    return;
  }
  for (const [providerId, providerValue] of Object.entries(parsed.providers)) {
    if (!isRecord(providerValue)) {
      continue;
    }
    const apiKey = providerValue.apiKey;
    if (coerceSecretRef(apiKey)) {
      params.addFinding({
        code: "REF_UNRESOLVED",
        severity: "error",
        file: params.modelsJsonPath,
        jsonPath: `providers.${providerId}.apiKey`,
        message: "models.json contains an unresolved SecretRef object; regenerate models.json.",
        provider: providerId,
      });
    } else if (
      isNonEmptyString(apiKey) &&
      !isNonSecretApiKeyMarker(apiKey) &&
      !isConfigOwnedEnvApiKeyMarker({
        providerId,
        marker: apiKey,
        refAssignments: params.refAssignments,
      })
    ) {
      params.addFinding({
        code: "PLAINTEXT_FOUND",
        severity: "warn",
        file: params.modelsJsonPath,
        jsonPath: `providers.${providerId}.apiKey`,
        message: "models.json provider apiKey is stored as plaintext.",
        provider: providerId,
      });
    }

    const headers = isRecord(providerValue.headers) ? providerValue.headers : undefined;
    if (!headers) {
      continue;
    }
    for (const [headerKey, headerValue] of Object.entries(headers)) {
      const headerPath = `providers.${providerId}.headers.${headerKey}`;
      if (coerceSecretRef(headerValue)) {
        params.addFinding({
          code: "REF_UNRESOLVED",
          severity: "error",
          file: params.modelsJsonPath,
          jsonPath: headerPath,
          message:
            "models.json contains an unresolved SecretRef object for provider headers; regenerate models.json.",
          provider: providerId,
        });
        continue;
      }
      if (!isNonEmptyString(headerValue)) {
        continue;
      }
      if (isSecretRefHeaderValueMarker(headerValue)) {
        continue;
      }
      if (!isLikelySensitiveModelProviderHeaderName(headerKey)) {
        continue;
      }
      params.addFinding({
        code: "PLAINTEXT_FOUND",
        severity: "warn",
        file: params.modelsJsonPath,
        jsonPath: headerPath,
        message: "models.json provider header value is stored as plaintext.",
        provider: providerId,
      });
    }
  }
}
