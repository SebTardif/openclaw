/**
 * Regression for #118627: sessions.reset / reason=new on the protected main
 * session must stay bounded when the row has stale runtime/provider fields and
 * no transcript. Re-entry during an in-flight reset must return UNAVAILABLE
 * instead of RangeError: Maximum call stack size exceeded.
 */
import { expect, test } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { writeSessionStore } from "./test-helpers.server.js";
import {
  directSessionReq,
  sessionHookMocks,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

function staleMissingMainEntry(): Partial<SessionEntry> {
  return {
    modelProvider: "stale-provider",
    model: "stale-model",
    status: "running",
    abortedLastRun: true,
    mainRestartRecovery: {
      cycleId: "cycle-stale-main",
      revision: 3,
      chargedAttempts: 3,
      tombstone: {
        reason: "restart recovery exhausted",
      },
    },
  };
}

test("sessions.reset recovers agent:main:main with stale runtime and missing transcript", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-main-stale-missing";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId, staleMissingMainEntry()),
    },
  });

  const before = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(before?.sessionId).toBe(sessionId);
  expect(before?.modelProvider).toBe("stale-provider");

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      abortedLastRun?: boolean;
      modelProvider?: string;
      model?: string;
    };
    resolved?: { modelProvider: string; model: string };
  }>("sessions.reset", { key: "agent:main:main" });

  expect(reset.ok).toBe(true);
  expect(reset.error).toBeUndefined();
  expect(reset.error?.message ?? "").not.toMatch(/Maximum call stack/i);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).toBe(sessionId);
  expect(reset.payload?.entry.abortedLastRun).toBe(false);
  // Runtime model projection is recomputed from current agent defaults.
  expect(reset.payload?.resolved?.modelProvider).toBeTruthy();
  expect(reset.payload?.resolved?.model).toBeTruthy();
  expect(reset.payload?.resolved?.modelProvider).not.toBe("stale-provider");

  const after = loadSessionEntry({ sessionKey: "agent:main:main", storePath }) as
    | SessionEntry
    | undefined;
  expect(after?.sessionId).toBe(sessionId);
  expect(after?.abortedLastRun).toBe(false);
  expect(after?.mainRestartRecovery).toBeUndefined();
});

test("sessions.reset reason=new recovers the same stale main-session fixture", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-main-stale-new";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId, staleMissingMainEntry()),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string };
  }>("sessions.reset", { key: "agent:main:main", reason: "new" });

  expect(reset.ok).toBe(true);
  expect(reset.error?.message ?? "").not.toMatch(/Maximum call stack/i);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).toBe(sessionId);

  const after = loadSessionEntry({ sessionKey: "agent:main:main", storePath }) as
    | SessionEntry
    | undefined;
  expect(after?.mainRestartRecovery).toBeUndefined();
});

test("sessions.reset re-entry on agent:main:main is bounded without stack overflow", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main-reentry", staleMissingMainEntry()),
    },
  });

  let nestedResult:
    | {
        ok: boolean;
        error?: { code?: string; message?: string };
      }
    | undefined;
  sessionHookMocks.triggerInternalHook.mockImplementation(async () => {
    if (nestedResult) {
      return undefined;
    }
    nestedResult = await directSessionReq("sessions.reset", { key: "agent:main:main" });
    return undefined;
  });

  try {
    const outer = await directSessionReq<{ ok: true; key: string }>("sessions.reset", {
      key: "agent:main:main",
    });
    expect(outer.ok).toBe(true);
    expect(outer.error?.message ?? "").not.toMatch(/Maximum call stack/i);

    expect(nestedResult).toBeDefined();
    expect(nestedResult?.ok).toBe(false);
    expect(nestedResult?.error?.code).toBe("UNAVAILABLE");
    expect(nestedResult?.error?.message).toMatch(/lifecycle mutation in progress/i);
    expect(nestedResult?.error?.message ?? "").not.toMatch(/Maximum call stack/i);
  } finally {
    sessionHookMocks.triggerInternalHook.mockReset();
  }
});
