import { afterEach, describe, expect, it } from "vitest";
import { waitForDead, waitForPidFile } from "../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executeDeps } from "./execute-deps.js";
import { executePreparedCliRun } from "./execute.js";

const activePids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;

afterEach(async () => {
  for (const pid of activePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await Promise.all([...activePids].map((pid) => waitForDead(pid, 5_000).catch(() => {})));
  activePids.clear();
  if (originalServiceMarker === undefined) {
    delete process.env.OPENCLAW_SERVICE_MARKER;
  } else {
    process.env.OPENCLAW_SERVICE_MARKER = originalServiceMarker;
  }
});

describe.skipIf(process.platform === "win32")("CLI-runner service construction", () => {
  it("settles a blocked real relay construction through the production CLI path", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const cwd = tempDirs.make("openclaw-cli-service-construction-");
    const pidPath = `${cwd}/command.pid`;
    const script = `
      require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      runId: "cli-service-construction",
      workspaceDir: cwd,
      timeoutMs: 500,
      backend: {
        command: process.execPath,
        args: ["-e", script],
        output: "text",
        input: "stdin",
        serialize: true,
        modelArg: undefined,
        systemPromptWhen: "never",
        systemPromptFileConfigArg: undefined,
        systemPromptFileConfigKey: undefined,
      },
    });
    context.cwd = cwd;
    context.preparedBackend.secretInput = {
      fd: 3,
      fingerprint: "construction-proof",
      createData: () => Buffer.alloc(8 * 1024 * 1024, 97),
    };

    const supervisor = createProcessSupervisor();
    const previousSupervisor = executeDeps.getProcessSupervisor;
    executeDeps.getProcessSupervisor = () => supervisor;
    try {
      const result = executePreparedCliRun(context);
      const commandPid = await waitForPidFile(pidPath, 5_000);
      activePids.add(commandPid);
      expect(process.kill(commandPid, 0)).toBe(true);
      await expect(result).rejects.toThrow(/timed out|timeout/iu);
      await waitForDead(commandPid, 5_000);
    } finally {
      executeDeps.getProcessSupervisor = previousSupervisor;
      await supervisor.shutdown().catch(() => undefined);
    }
  });
});
