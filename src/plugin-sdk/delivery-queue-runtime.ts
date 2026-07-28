// Delivery queue runtime helpers persist and replay outbound plugin delivery work.
import {
  drainPendingDeliveries as coreDrainPendingDeliveries,
  type DeliverFn,
  type ReconnectDrainResult,
} from "../infra/outbound/delivery-queue.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export type { ReconnectDrainResult };

type DrainPendingDeliveriesOptions = Omit<
  Parameters<typeof coreDrainPendingDeliveries>[0],
  "deliver"
> & {
  /** Optional delivery implementation for tests or plugin-owned send paths. */
  deliver?: DeliverFn;
  /**
   * Additive result seam: published `drainPendingDeliveries` stays `Promise<void>`.
   * Callers that need reconnect-drain stats (matched / in-progress skips) pass this
   * callback instead of relying on a return-type change.
   */
  onResult?: (result: ReconnectDrainResult) => void;
};

const loadOutboundDeliverRuntime = createLazyRuntimeModule(
  () => import("../infra/outbound/deliver-runtime.js"),
);

/**
 * Drain queued outbound payloads after a channel reconnect or transport recovery.
 * When no deliver function is provided, the heavy outbound delivery runtime is
 * loaded lazily so importing this SDK subpath does not eagerly bind send internals.
 *
 * Public contract: `Promise<void>` (Plugin SDK compatibility). Use `onResult`
 * for drain statistics without changing the published return type.
 */
export async function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void> {
  const { onResult, ...drainOpts } = opts;
  await runWithGatewayIndependentRootWorkAdmission(async () => {
    // Keep lazy resolution and draining in one lease so suspension cannot split the handoff.
    const deliver =
      drainOpts.deliver ?? (await loadOutboundDeliverRuntime()).deliverOutboundPayloadsInternal;
    const result = await coreDrainPendingDeliveries({
      ...drainOpts,
      deliver,
    });
    onResult?.(result);
  });
}
