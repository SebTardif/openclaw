import type { ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec-file.js";
import {
  createExecFileError,
  type ExecFileError,
  type ExecFileMock,
} from "./systemd-exec.test-support.js";

const execFileMock = vi.hoisted(() => vi.fn<ExecFileMock>());
const findSystemGatewayServicesMock = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Array<{
        platform: "linux";
        label: string;
        detail: string;
        scope: "user" | "system";
        marker?: "openclaw" | "clawdbot";
        legacy?: boolean;
      }>
    >
  >(async () => []),
);
const assertNoSystemSystemdOwnershipMock = vi.hoisted(() =>
  vi.fn<(unitName: string, timeoutMs?: number) => Promise<void>>(async () => {}),
);

vi.mock("./inspect.js", () => ({
  findSystemGatewayServices: () => findSystemGatewayServicesMock(),
}));

vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: (unitName: string, timeoutMs?: number) =>
    timeoutMs === undefined
      ? assertNoSystemSystemdOwnershipMock(unitName)
      : assertNoSystemSystemdOwnershipMock(unitName, timeoutMs),
}));

vi.mock("./exec-file.js", () => ({
  execFileUtf8: async (
    command: string,
    args: string[],
    options: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
  ): Promise<ExecResult> => {
    let settled: ExecResult | undefined;
    execFileMock(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      settled = {
        stdout: stdout ?? "",
        stderr: stderr || error?.message || "",
        code: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
        termination: error?.termination ?? (typeof error?.code === "string" ? "error" : "exit"),
        errorCode: typeof error?.code === "string" ? error.code : undefined,
      };
    });
    if (!settled) {
      return { code: 0, termination: "exit", stdout: "", stderr: "" };
    }
    return settled;
  },
}));

import {
  findInstalledSystemdGatewayScope,
  readSystemdServiceExecStart,
  startSystemdService,
  uninstallUserSystemdGatewayUnit,
} from "./systemd.js";

const TEST_MANAGED_HOME = "/tmp/openclaw-test-home";

const createWritableStreamMock = (write = vi.fn()) => {
  const stdout = { write };
  return { write, stdout: stdout as typeof stdout & NodeJS.WritableStream };
};

function pathLikeToString(pathname: unknown): string {
  if (typeof pathname === "string") {
    return pathname;
  }
  if (pathname instanceof URL) {
    return pathname.pathname;
  }
  if (pathname instanceof Uint8Array) {
    return Buffer.from(pathname).toString("utf8");
  }
  return "";
}

function assertUserSystemctlArgs(args: string[], ...command: string[]) {
  expect(args).toEqual(["--user", ...command]);
}

function systemctlUserSuccess(...command: string[]): ExecFileMock {
  return (_cmd, args, _opts, cb) => {
    assertUserSystemctlArgs(args, ...command);
    cb(null, "", "");
  };
}

function execFileSuccess(): ExecFileMock {
  return (_cmd, _args, _opts, cb) => cb(null, "", "");
}

type ExecFileResult = [error: ExecFileError | null, stdout: string, stderr: string];

function systemctlVersionResult(result: ExecFileResult = [null, "", ""]): ExecFileMock {
  return (_command, args, _options, done) => {
    expect(args).toEqual(["--version"]);
    done(...result);
  };
}

function mockUnitFileLayout(layout: {
  user?: boolean | string | string[];
  system?: string | false;
}) {
  vi.spyOn(fs, "access").mockImplementation(async (pathArg) => {
    const p = pathLikeToString(pathArg);
    const userOk = (() => {
      if (!layout.user) {
        return false;
      }
      if (layout.user === true) {
        return p.includes("/.config/systemd/user/");
      }
      const names = Array.isArray(layout.user) ? layout.user : [layout.user];
      return names.some((name) => p.includes("/.config/systemd/user/") && p.endsWith(`/${name}`));
    })();
    if (userOk) {
      return undefined;
    }
    if (typeof layout.system === "string" && p === layout.system) {
      return undefined;
    }
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

describe("systemd gateway identity (openclaw#119648)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
    findSystemGatewayServicesMock.mockReset().mockResolvedValue([]);
    assertNoSystemSystemdOwnershipMock.mockReset();
    assertNoSystemSystemdOwnershipMock.mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("findInstalledSystemdGatewayScope falls back to marker-owned system unit with custom name", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw.service",
        detail: "unit: /etc/systemd/system/openclaw.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw.service",
      unitPath: "/etc/systemd/system/openclaw.service",
    });
  });

  it("findInstalledSystemdGatewayScope refuses marker-owned units from another profile", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-darlene.service",
        detail: "unit: /etc/systemd/system/openclaw-darlene.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "lisa",
    });
    expect(result).toBeNull();
  });

  it("default profile does not adopt an unrelated named-profile marker unit", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-darlene.service",
        detail: "unit: /etc/systemd/system/openclaw-darlene.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "default",
    });
    expect(result).toBeNull();
  });

  it("default profile without OPENCLAW_PROFILE also refuses unrelated marker units", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-darlene.service",
        detail: "unit: /etc/systemd/system/openclaw-darlene.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("default profile does not adopt arbitrary custom marker units without override", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "my-custom-gateway.service",
        detail: "unit: /etc/systemd/system/my-custom-gateway.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({ HOME: TEST_MANAGED_HOME });
    expect(result).toBeNull();
  });

  it("findInstalledSystemdGatewayScope accepts legacy openclaw-<profile> system unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-lisa.service" });
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "lisa",
    });
    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-lisa.service",
      unitPath: "/etc/systemd/system/openclaw-lisa.service",
    });
  });

  it("does not adopt Node or another profile's canonical unit as this profile's legacy name", async () => {
    mockUnitFileLayout({
      user: ["openclaw-node.service", "openclaw-gateway.service", "openclaw-gateway-lisa.service"],
    });
    await expect(
      findInstalledSystemdGatewayScope({
        HOME: TEST_MANAGED_HOME,
        OPENCLAW_PROFILE: "node",
      }),
    ).resolves.toBeNull();
    await expect(
      findInstalledSystemdGatewayScope({
        HOME: TEST_MANAGED_HOME,
        OPENCLAW_PROFILE: "gateway",
      }),
    ).resolves.toBeNull();
    await expect(
      findInstalledSystemdGatewayScope({
        HOME: TEST_MANAGED_HOME,
        OPENCLAW_PROFILE: "gateway-lisa",
      }),
    ).resolves.toBeNull();
  });

  it("findInstalledSystemdGatewayScope honors OPENCLAW_SYSTEMD_UNIT for Node unit", async () => {
    mockUnitFileLayout({ system: "/etc/systemd/system/openclaw-node.service" });
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "lisa",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
    });
    expect(result).toEqual({
      scope: "system",
      unitName: "openclaw-node.service",
      unitPath: "/etc/systemd/system/openclaw-node.service",
    });
  });

  it("findInstalledSystemdGatewayScope honors OPENCLAW_SYSTEMD_UNIT for custom user unit", async () => {
    mockUnitFileLayout({ user: true, system: false });
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_PROFILE: "lisa",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-lisa",
    });
    expect(result?.scope).toBe("user");
    expect(result?.unitName).toBe("openclaw-gateway-lisa.service");
    expect(result?.unitPath).toContain("/.config/systemd/user/openclaw-gateway-lisa.service");
  });

  it("explicit OPENCLAW_SYSTEMD_UNIT does not adopt an unrelated profile unit", async () => {
    mockUnitFileLayout({ system: false });
    findSystemGatewayServicesMock.mockResolvedValueOnce([
      {
        platform: "linux",
        label: "openclaw-darlene.service",
        detail: "unit: /etc/systemd/system/openclaw-darlene.service",
        scope: "system",
        marker: "openclaw",
      },
    ]);
    const result = await findInstalledSystemdGatewayScope({
      HOME: TEST_MANAGED_HOME,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-node",
    });
    expect(result).toBeNull();
  });

  it("inspects the discovered legacy user unit when the canonical file is absent", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-inspect-"));
    const env = { HOME: home, OPENCLAW_PROFILE: "lisa" };
    const unitPath = path.join(home, ".config", "systemd", "user", "openclaw-lisa.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.writeFile(
        unitPath,
        "[Service]\nExecStart=/usr/bin/openclaw gateway run --port 18790\n",
        { encoding: "utf8", mode: 0o644 },
      );
      execFileMock.mockImplementation((_command, _args, _options, callback) => {
        callback(createExecFileError("Call failed: Unit openclaw-lisa.service not found."), "", "");
      });
      await expect(readSystemdServiceExecStart(env)).resolves.toMatchObject({
        programArguments: ["/usr/bin/openclaw", "gateway", "run", "--port", "18790"],
        sourcePath: unitPath,
      });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("disables and removes the discovered legacy user unit", async () => {
    const tempHomeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-user-unit-"));
    const home = path.join(tempHomeRoot, "home");
    const env = { HOME: home, OPENCLAW_PROFILE: "lisa" };
    const unitPath = path.join(home, ".config", "systemd", "user", "openclaw-lisa.service");
    try {
      await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
      await fs.writeFile(unitPath, "[Unit]\nDescription=OpenClaw Gateway (profile: lisa)\n", {
        encoding: "utf8",
        mode: 0o644,
      });
      execFileMock
        .mockImplementationOnce(systemctlVersionResult())
        .mockImplementationOnce(systemctlUserSuccess("disable", "--now", "openclaw-lisa.service"))
        .mockImplementationOnce(systemctlUserSuccess("daemon-reload"));

      const { stdout } = createWritableStreamMock();
      const result = await uninstallUserSystemdGatewayUnit({ env, stdout });

      expect(result).toMatchObject({
        unitName: "openclaw-lisa.service",
        unitPath,
        removed: true,
        disabled: true,
      });
      await expect(fs.access(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(tempHomeRoot, { recursive: true, force: true });
    }
  });

  it("checks system ownership for the selected legacy user unit", async () => {
    vi.spyOn(fs, "access").mockImplementation(async (target) => {
      const p = pathLikeToString(target);
      if (p.includes("/.config/systemd/user/") && p.endsWith("/openclaw-lisa.service")) {
        return;
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    assertNoSystemSystemdOwnershipMock.mockRejectedValueOnce(
      new Error("same-name system ownership"),
    );
    execFileMock.mockImplementation(execFileSuccess());

    await expect(
      startSystemdService({
        stdout: createWritableStreamMock().stdout,
        env: { HOME: TEST_MANAGED_HOME, OPENCLAW_PROFILE: "lisa" },
      }),
    ).rejects.toThrow("same-name system ownership");

    expect(assertNoSystemSystemdOwnershipMock).toHaveBeenCalledWith("openclaw-lisa.service");
  });
});
