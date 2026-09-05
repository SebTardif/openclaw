/**
 * Tests scoped pairing upsert so runtime extras cannot remap accountId.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { createScopedPairingAccess } from "./pairing-access.js";

describe("createScopedPairingAccess", () => {
  it("keeps the scoped channel and accountId when upsert input carries extras", async () => {
    const upsertPairingRequest = vi.fn(async () => ({ code: "PAIRCODE", created: true }));
    const runtime = {
      channel: {
        pairing: {
          upsertPairingRequest,
        },
      },
    } as unknown as PluginRuntime;

    const pairing = createScopedPairingAccess({
      core: runtime,
      channel: "telegram",
      accountId: "scoped-account",
    });

    await pairing.upsertPairingRequest({
      id: "req-1",
      accountId: "attacker-account",
      channel: "other",
    } as never);

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      id: "req-1",
      accountId: normalizeAccountId("scoped-account"),
      channel: "telegram",
    });
  });
});
