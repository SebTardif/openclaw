import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetGatewayWorkAdmission();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function withQueue<T>(
  run: (queue: ChannelIngressQueue<StoredEvent>) => Promise<T>,
): Promise<T> {
  const stateDir = tempDirs.make("openclaw-ingress-monitor-restart-drain-");
  try {
    return await run(
      createChannelIngressQueue<StoredEvent>({ channelId: "test", accountId: "a", stateDir }),
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

function createMonitor(queue: ChannelIngressQueue<StoredEvent>) {
  return createChannelIngressMonitor<RawEvent, string, StoredEvent>({
    queue,
    inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
    payload: {
      storage: "raw-event",
      version: 1,
      serialize: (raw) => JSON.stringify(raw),
      deserialize: (body) => JSON.parse(body) as RawEvent,
      createClaimError: (kind) => new Error(kind),
    },
    deliver: vi.fn(),
    pollIntervalMs: 60_000,
    retention: { pruneIntervalMs: 60_000 },
    drain: {
      adoptionStallTimeoutMs: 5_000,
      retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
      resolveNonRetryableFailure: () => null,
    },
  });
}

describe("channel ingress monitor restart drain idle", () => {
  it("resolves waitForIdle when restart drain leaves a queued request latched", async () => {
    await withQueue(async (queue) => {
      let markPruneStarted = () => {};
      const pruneStarted = new Promise<void>((resolve) => {
        markPruneStarted = resolve;
      });
      let releasePrune: (error?: Error) => void = () => {};
      const pruneGate = new Promise<void>((resolve, reject) => {
        releasePrune = (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };
      });
      const prune = queue.prune.bind(queue);
      queue.prune = async (...args) => {
        markPruneStarted();
        await pruneGate;
        return await prune(...args);
      };
      const isRestartDraining = vi
        .spyOn(gatewayWorkAdmission, "isGatewayRestartDraining")
        .mockReturnValue(false);
      const monitor = createMonitor(queue);
      monitor.start();
      await pruneStarted;

      monitor.requestDrain();
      isRestartDraining.mockReturnValue(true);
      markGatewayRestartDraining();
      releasePrune(new Error("restart drain interrupted prune"));
      await monitor.waitForPumpIdle();

      const result = await Promise.race([
        monitor.waitForIdle().then(() => "idle" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 200);
        }),
      ]);
      expect(result).toBe("idle");
      await monitor.stop();
    });
  });

  it("does not start a pump when requestDrain sees restart drain", async () => {
    await withQueue(async (queue) => {
      const prune = vi.spyOn(queue, "prune");
      const monitor = createMonitor(queue);
      monitor.start();
      await monitor.waitForIdle();
      const pruneCallsAfterIdle = prune.mock.calls.length;

      vi.spyOn(gatewayWorkAdmission, "isGatewayRestartDraining").mockReturnValue(true);
      markGatewayRestartDraining();
      monitor.requestDrain();

      const result = await Promise.race([
        monitor.waitForIdle().then(() => "idle" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 200);
        }),
      ]);
      expect(result).toBe("idle");
      expect(prune).toHaveBeenCalledTimes(pruneCallsAfterIdle);
      await monitor.stop();
    });
  });
});
