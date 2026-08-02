import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostAppStatus } from "@hermes-studio/protocol";

const OBSIDIAN_APP_PATHS = [
  "/Applications/Obsidian.app",
  join(homedir(), "Applications", "Obsidian.app"),
] as const;
const HOMEBREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] as const;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1_000;
const INSTALL_KILL_GRACE_MS = 5_000;
const SHUTDOWN_KILL_GRACE_MS = 2_000;
const SHUTDOWN_SETTLEMENT_GRACE_MS = 500;
const HOMEBREW_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const HOMEBREW_ENV_KEYS = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * Fixed-function host application manager. It intentionally accepts no app id,
 * package name, executable, arguments, or shell input from HTTP clients.
 */
export class HostAppManager {
  #phase: HostAppStatus["phase"] | undefined;
  #failure: HostAppStatus["failure"];
  #installer: ChildProcess | undefined;
  #timeout: ReturnType<typeof setTimeout> | undefined;
  #killTimeout: ReturnType<typeof setTimeout> | undefined;
  #closeFlight: Promise<void> | undefined;

  obsidianStatus(): HostAppStatus {
    if (OBSIDIAN_APP_PATHS.some((candidate) => existsSync(candidate))) {
      this.#phase = "installed";
      this.#failure = undefined;
      return status("installed", true, false);
    }
    if (platform() !== "darwin") return status("unsupported", false, false, "unsupported_platform");
    if (this.#phase === "failed") {
      return status("failed", false, this.#installer === undefined, this.#failure ?? "install_failed");
    }
    if (this.#installer !== undefined || this.#phase === "installing") return status("installing", false, false);
    const brew = homebrewPath();
    if (brew === undefined) return status("blocked", false, false, "homebrew_missing");
    return status("available", false, true);
  }

  installObsidian(): HostAppStatus {
    const current = this.obsidianStatus();
    if (current.phase === "installed" || current.phase === "installing" || !current.canInstall) return current;
    const brew = homebrewPath();
    if (brew === undefined) return status("blocked", false, false, "homebrew_missing");

    this.#phase = "installing";
    this.#failure = undefined;
    const child = spawn(brew, ["install", "--cask", "obsidian"], {
      shell: false,
      stdio: "ignore",
      env: homebrewChildEnvironment(),
    });
    this.#installer = child;
    this.#timeout = setTimeout(() => {
      if (this.#installer !== child) return;
      this.#failure = "install_timeout";
      this.#phase = "failed";
      child.kill("SIGTERM");
      this.#killTimeout = setTimeout(() => {
        if (this.#installer === child) child.kill("SIGKILL");
      }, INSTALL_KILL_GRACE_MS);
      this.#killTimeout.unref?.();
    }, INSTALL_TIMEOUT_MS);
    this.#timeout.unref?.();

    child.once("error", () => this.#finish(child, false));
    child.once("exit", (code) => this.#finish(child, code === 0));
    return this.obsidianStatus();
  }

  close(): Promise<void> {
    if (this.#closeFlight !== undefined) return this.#closeFlight;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    if (this.#killTimeout !== undefined) clearTimeout(this.#killTimeout);
    this.#timeout = undefined;
    this.#killTimeout = undefined;
    const child = this.#installer;
    const flight = terminateChild(child, SHUTDOWN_KILL_GRACE_MS, SHUTDOWN_SETTLEMENT_GRACE_MS).finally(() => {
      if (this.#installer === child) this.#installer = undefined;
    });
    this.#closeFlight = flight;
    return flight;
  }

  #finish(child: ChildProcess, succeeded: boolean): void {
    if (this.#installer !== child) return;
    if (this.#timeout !== undefined) clearTimeout(this.#timeout);
    if (this.#killTimeout !== undefined) clearTimeout(this.#killTimeout);
    this.#timeout = undefined;
    this.#killTimeout = undefined;
    this.#installer = undefined;
    if (succeeded && OBSIDIAN_APP_PATHS.some((candidate) => existsSync(candidate))) {
      this.#phase = "installed";
      this.#failure = undefined;
      return;
    }
    this.#phase = "failed";
    this.#failure ??= "install_failed";
  }
}

async function terminateChild(
  child: ChildProcess | undefined,
  termGraceMs: number,
  settlementGraceMs: number,
): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let settlementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
      child.off("close", finish);
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      settlementTimer = setTimeout(finish, settlementGraceMs);
    }, termGraceMs);
  });
}

function homebrewPath(): string | undefined {
  for (const candidate of HOMEBREW_PATHS) {
    const validated = validatedLocalExecutable(candidate);
    if (validated !== undefined) return validated;
  }
  return undefined;
}

export function validatedLocalExecutable(candidate: string): string | undefined {
  try {
    const canonical = realpathSync(candidate);
    const metadata = statSync(canonical);
    const effectiveUid = process.geteuid?.();
    if (!metadata.isFile()) return undefined;
    if ((metadata.mode & 0o6000) !== 0) return undefined;
    if ((metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0) return undefined;
    if (metadata.uid !== 0 && (effectiveUid === undefined || metadata.uid !== effectiveUid)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

export function homebrewChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: HOMEBREW_PATH };
  for (const key of HOMEBREW_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) result[key] = value;
  }
  return result;
}

function status(
  phase: HostAppStatus["phase"],
  installed: boolean,
  canInstall: boolean,
  failure?: HostAppStatus["failure"],
): HostAppStatus {
  return {
    id: "obsidian",
    name: "Obsidian",
    phase,
    installed,
    canInstall,
    installMethod: "homebrew-cask",
    ...(failure === undefined ? {} : { failure }),
  };
}
