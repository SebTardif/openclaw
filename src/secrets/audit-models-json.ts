/** models.json plaintext / unresolved-ref collection for secrets audit. */
import fs from "node:fs";
import {
  isNonSecretApiKeyMarker,
  isSecretRefHeaderValueMarker,
} from "../agents/model-auth-markers.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { normalizeProviderMapKeys } from "../agents/models-config.merge.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef, resolveSecretInputRef } from "../config/types.secrets.js";
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

type ModelsProviders = NonNullable<OpenClawConfig["models"]>["providers"];
type SourceProviderConfig = NonNullable<ModelsProviders>[string];
type SecretDefaults = NonNullable<NonNullable<OpenClawConfig["secrets"]>["defaults"]>;

/**
 * models.json persists env SecretRefs as bare env-name markers (for example
 * "FACTCHAT_API_KEY"), not only the built-in known-marker list. Accept those
 * only when the writer-winning models.providers entry owns the same env id.
 * talk.providers / talk.realtime.providers with the same provider+env id must
 * not suppress a plaintext models.json finding.
 */
function normalizeSourceProviderLookup(
  providers: ModelsProviders | undefined,
): Record<string, SourceProviderConfig> {
  if (!providers) {
    return {};
  }
  const validProviders = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isRecord(provider)),
  ) as Record<string, SourceProviderConfig>; // SAFETY: isRecord keeps object providers; keys are unchanged.
  // Writer collision rule: exact canonical spelling wins over aliases.
  return normalizeProviderMapKeys(validProviders);
}

function resolveOwnedEnvApiKeyMarker(
  sourceProvider: SourceProviderConfig | undefined,
  defaults: SecretDefaults | undefined,
): string | undefined {
  if (!sourceProvider) {
    return undefined;
  }
  const { ref } = resolveSecretInputRef({
    value: sourceProvider.apiKey,
    defaults,
  });
  if (!ref || ref.source !== "env") {
    return undefined;
  }
  const marker = ref.id.trim();
  return marker || undefined;
}

function isConfigOwnedEnvApiKeyMarker(params: {
  providerId: string;
  marker: string;
  sourceProvidersByKey: Record<string, SourceProviderConfig>;
  secretDefaults?: SecretDefaults;
}): boolean {
  const marker = params.marker.trim();
  if (!marker) {
    return false;
  }
  const providerKey = normalizeProviderId(params.providerId);
  if (!providerKey) {
    return false;
  }
  return (
    resolveOwnedEnvApiKeyMarker(params.sourceProvidersByKey[providerKey], params.secretDefaults) ===
    marker
  );
}

/** Collect models.json findings for plaintext credentials and unresolved SecretRef objects. */
export function collectModelsJsonSecrets(params: {
  modelsJsonPath: string;
  maxBytes: number;
  filesScanned: Set<string>;
  sourceProviders?: ModelsProviders;
  secretDefaults?: SecretDefaults;
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
  const sourceProvidersByKey = normalizeSourceProviderLookup(params.sourceProviders);
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
        sourceProvidersByKey,
        secretDefaults: params.secretDefaults,
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
