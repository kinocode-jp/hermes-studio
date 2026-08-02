import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import {
  isRemotePrivilegedOperation,
  OPERATION_POLICIES,
  type DeviceSummary,
  type EffectiveAccess,
  type Operation,
  type PermissionTier,
} from "@hermes-studio/protocol";
import { isLoopbackOrigin, isTrustedLocalOrigin, normalizeOrigin } from "./origin.js";

// Compatibility wire IDs: keep pre-rebrand cookie / capability names so enrolled
// browsers (including Pixel Fold PWAs) and desktop sessions stay signed in.
// Product brand is Hermes Studio; these are not user-facing product names.
const COOKIE_NAME = "hermes_office_session";
const DEVICE_COOKIE_NAME = "hermes_office_device";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_SESSIONS = 64;
const MAX_DEVICES = 32;
const MAX_AUDIT_RECORDS = 256;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_CLIENT_ATTEMPTS = 5;
const MAX_GLOBAL_ATTEMPTS = 100;
const MAX_RATE_LIMIT_KEYS = 512;
const MAX_RENEW_GLOBAL_ATTEMPTS = 100;
const MAX_RENEW_CLIENT_ATTEMPTS = 6;
const MAX_RENEW_DEVICE_ATTEMPTS = 8;
const SESSION_RENEW_WINDOW_MS = 30 * 60_000;
const LAST_SEEN_WRITE_COOLDOWN_MS = 5 * 60_000;
const DESKTOP_CAPABILITY_HEADER = "x-hermes-office-desktop-capability";
const DESKTOP_PROTOCOL_PREFIX = "hermes-office.desktop.";
const DEFAULT_DESKTOP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] as const;
// Intentional policy: the Tauri bridge origins are exactly the three portless constants above.
// A port-bearing Tauri origin (e.g. tauri://localhost:1234) is rejected; development HTTP origins
// are configured explicitly as an allowed localhost HTTP(S) origin, with or without a port as
// applicable, instead of the tauri scheme.
const TIER_RANK: Readonly<Record<PermissionTier, number>> = { viewer: 0, operator: 1, manager: 2, owner: 3 };

export interface OfficePrincipal {
  id: string;
  tier: PermissionTier;
  local: boolean;
  deviceName: string;
}

export interface OfficeAuthSession {
  principal: OfficePrincipal;
  csrfToken: string;
  expiresAt: string;
}

export interface OfficePublicAuditRecord {
  occurredAt: string;
  operation: string;
  outcome: "allowed" | "denied" | "rate_limited";
  deviceName: string | null;
  local: boolean;
}

export interface OfficeAuditRecord extends OfficePublicAuditRecord {
  id: string;
  actorId: string | null;
  deviceId: string | null;
}

export interface OfficeAuthOptions {
  remoteToken?: string;
  desktopCapability?: string;
  desktopOrigins?: readonly string[];
  allowedOrigins?: readonly string[];
  trustedProxyHops?: number;
  deviceRegistryPath?: string;
  /**
   * When true, remote owner sessions may use privileged-config.* and secret.write.
   * Default false (fail closed). Local sessions are unaffected.
   * Set via HERMES_STUDIO_REMOTE_PRIVILEGED (or deprecated HERMES_OFFICE_REMOTE_PRIVILEGED).
   * Tailscale launcher enables intentionally.
   */
  remotePrivilegedEnabled?: boolean;
  onAudit?: (record: OfficeAuditRecord) => void;
}

export type DeviceBootstrapResult =
  | { outcome: "success"; session: OfficeAuthSession; enrolled: boolean }
  | { outcome: "disabled" | "invalid" | "rate_limited" | "insecure_transport" | "enrollment_consumed" | "storage_unavailable" };

export type AuthorizationResult =
  | { allowed: true; session: OfficeAuthSession }
  | { allowed: false; reason: "unauthenticated" | "csrf" | "tier" | "step_up_required" | "local_only" };

interface StoredSession extends OfficeAuthSession { expiresAtMs: number; }
interface AttemptWindow { count: number; resetAt: number; }
interface DeviceRecord {
  id: string;
  displayName: string;
  tier: PermissionTier;
  credentialDigest: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  expiresAtMs: number;
}

export class OfficeAuth {
  readonly #sessions = new Map<string, StoredSession>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #remoteTokenDigest: Buffer | undefined;
  readonly #remoteTokenGeneration: string | undefined;
  readonly #desktopCapabilityDigest: Buffer | undefined;
  readonly #desktopSession: OfficeAuthSession | undefined;
  readonly #desktopOrigins: ReadonlySet<string>;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #trustedProxyHops: number;
  readonly #deviceRegistryPath: string | undefined;
  readonly #remotePrivilegedEnabled: boolean;
  readonly #onAudit: ((record: OfficeAuditRecord) => void) | undefined;
  readonly #audit: OfficeAuditRecord[] = [];
  readonly #attempts = new Map<string, AttemptWindow>();
  readonly #renewAttempts = new Map<string, AttemptWindow>();
  #registryWriteTail: Promise<void> = Promise.resolve();
  #lastSeenDirty = false;
  #lastSeenFlush: Promise<void> | undefined;
  #enrollmentConsumed = false;

  constructor(options: OfficeAuthOptions = {}) {
    this.#desktopOrigins = validateDesktopOrigins(options.desktopOrigins ?? DEFAULT_DESKTOP_ORIGINS);
    this.#allowedOrigins = validateAllowedOrigins(options.allowedOrigins);
    this.#trustedProxyHops = boundedInteger(options.trustedProxyHops, 0, 0, 8);
    this.#remotePrivilegedEnabled = options.remotePrivilegedEnabled === true;
    if (options.remoteToken !== undefined) {
      if (options.remoteToken.length < 32 || options.remoteToken.length > 4_096 || options.remoteToken.includes("\0")) {
        throw new Error("Remote enrollment token must contain 32 to 4096 characters.");
      }
      this.#remoteTokenDigest = secretDigest(options.remoteToken);
      this.#remoteTokenGeneration = tokenDigest(options.remoteToken);
    }
    if (options.desktopCapability !== undefined) {
      if (!isValidDesktopCapability(options.desktopCapability)) {
        throw new Error("Desktop capability must contain 32 to 256 URL-safe characters.");
      }
      this.#desktopCapabilityDigest = secretDigest(options.desktopCapability);
      this.#desktopSession = {
        principal: { id: "local-desktop", tier: "owner", local: true, deviceName: "Local desktop" },
        csrfToken: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      };
    }
    this.#deviceRegistryPath = normalizeRegistryPath(options.deviceRegistryPath);
    // SECURITY/ARCHITECTURE: An existing registry is marked enrollment-consumed before parsing.
    // Corrupt or unreadable content intentionally remains consumed so that registry-write access
    // cannot reopen enrollment. Owner recovery requires inspecting, replacing, or removing the file
    // while Office is stopped.
    this.#loadDeviceRegistry();
    this.#onAudit = options.onAudit;
  }

  get remoteEnabled(): boolean { return this.#remoteTokenDigest !== undefined; }

  bootstrapLocal(request: IncomingMessage, response: ServerResponse): OfficeAuthSession | undefined {
    if (!isTrustedLocalRequest(request)) {
      this.#appendAudit("auth.local", "denied", undefined, true);
      return undefined;
    }
    const session = this.#issueSession(request, response, {
      id: "local-browser", tier: "owner", local: true, deviceName: "Local browser",
    });
    this.#appendAudit("auth.local", "allowed", session, true);
    return session;
  }

  async bootstrapDevice(
    request: IncomingMessage,
    response: ServerResponse,
    credentials: { token: string; deviceName: string },
  ): Promise<DeviceBootstrapResult> {
    if (this.#remoteTokenDigest === undefined) return { outcome: "disabled" };
    if (!this.#isTrustedSecureProxyRequest(request)) return { outcome: "insecure_transport" };
    if (!this.#consumeRemoteAttempts(request, credentials.token)) {
      this.#appendAudit("auth.device", "rate_limited", undefined, false);
      return { outcome: "rate_limited" };
    }
    const deviceName = normalizeDeviceName(credentials.deviceName);
    if (deviceName === undefined) return this.#invalidDevice();

    const existing = this.#authenticateDeviceCredential(request, credentials.token);
    if (existing !== undefined) {
      return { outcome: "success", session: this.#issueDeviceSession(request, response, existing), enrolled: false };
    }
    if (!safeBufferEqual(secretDigest(credentials.token), this.#remoteTokenDigest)) return this.#invalidDevice();
    if (this.#enrollmentConsumed) {
      this.#appendAudit("auth.device", "denied", undefined, false);
      return { outcome: "enrollment_consumed" };
    }
    if (this.#devices.size >= MAX_DEVICES) return this.#invalidDevice();

    const credential = randomBytes(32).toString("base64url");
    const id = `device-${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    // Single trusted remote operator model: when remote privileged is enabled
    // (Tailscale path), the one-time enrolled device is owner so privileged
    // settings are usable. Without the flag, remain operator (chat/kanban only).
    const device: DeviceRecord = {
      id,
      displayName: deviceName,
      tier: this.#remotePrivilegedEnabled ? "owner" : "operator",
      credentialDigest: tokenDigest(credential),
      createdAt: now,
      lastSeenAt: now,
      expiresAtMs: Date.now() + DEVICE_TTL_MS,
    };
    this.#devices.set(id, device);
    this.#enrollmentConsumed = true;
    if (!await this.#saveDeviceRegistry()) {
      this.#devices.delete(id);
      return { outcome: "storage_unavailable" };
    }
    // Issue the short-lived session cookie first, then append the long-lived
    // device cookie last. Some Android Chrome / Tailscale Serve paths retain
    // only the final Set-Cookie header; losing the device cookie prevents
    // /api/v1/auth/device/renew after the in-memory session path fails.
    // Security attributes are unchanged (HttpOnly, SameSite=Strict, Secure).
    const session = this.#issueDeviceSession(request, response, device);
    response.appendHeader("Set-Cookie", serializeDeviceCookie(`${id}.${credential}`, request, this.#trustedProxyHops));
    return { outcome: "success", session, enrolled: true };
  }

  renewDevice(request: IncomingMessage, response: ServerResponse): DeviceBootstrapResult {
    if (this.#remoteTokenDigest === undefined) return { outcome: "disabled" };
    if (!this.#isTrustedSecureProxyRequest(request)) return { outcome: "insecure_transport" };
    const device = this.#authenticateDeviceCredential(request, "");
    if (device === undefined) return this.#invalidDevice();
    if (!this.#consumeRenewAttempts(request, device.id)) {
      this.#appendAudit("auth.device", "rate_limited", undefined, false, device.id);
      return { outcome: "rate_limited" };
    }
    const active = this.#activeDeviceSession(request, device.id);
    this.#scheduleLastSeen(device);
    if (active !== undefined) {
      this.#appendAudit("auth.device", "allowed", active, false);
      return { outcome: "success", session: active, enrolled: false };
    }
    return { outcome: "success", session: this.#issueDeviceSession(request, response, device), enrolled: false };
  }

  async flushRegistryWrites(): Promise<void> {
    await this.#lastSeenFlush;
    await this.#registryWriteTail;
  }

  authenticate(request: IncomingMessage): OfficeAuthSession | undefined {
    const desktop = this.#authenticateDesktop(request);
    if (desktop !== undefined) return desktop;
    this.#prune();
    const rawToken = readCookie(request.headers.cookie, COOKIE_NAME);
    if (rawToken === undefined || rawToken.length > 128) return undefined;
    const stored = this.#sessions.get(tokenDigest(rawToken));
    if (stored === undefined) return undefined;
    if (!stored.principal.local) {
      const device = this.#devices.get(stored.principal.id);
      if (device === undefined || device.revokedAt !== undefined || device.expiresAtMs <= Date.now()) return undefined;
    }
    return publicSession(stored);
  }

  authorizeOperation(request: IncomingMessage, operation: Operation, mutation: boolean): AuthorizationResult {
    const session = this.authenticate(request);
    if (session === undefined) return { allowed: false, reason: "unauthenticated" };
    if (mutation && session.principal.id !== "local-desktop") {
      const supplied = request.headers["x-csrf-token"];
      if (typeof supplied !== "string" || !safeEqual(supplied, session.csrfToken)) return { allowed: false, reason: "csrf" };
    }
    return this.authorizeSession(session, operation);
  }

  /** Compatibility helper for callers that only need the CSRF/session gate. */
  authorizeMutation(request: IncomingMessage): OfficeAuthSession | undefined {
    const result = this.authorizeOperation(request, "state.read", true);
    return result.allowed ? result.session : undefined;
  }

  authorizeSession(session: OfficeAuthSession, operation: Operation): AuthorizationResult {
    const policy = OPERATION_POLICIES[operation];
    let reason: Exclude<AuthorizationResult, { allowed: true }>["reason"];
    if (TIER_RANK[session.principal.tier] < TIER_RANK[policy.minimumTier]) reason = "tier";
    else if (policy.boundary === "local-only" && !session.principal.local) reason = "local_only";
    else if (policy.boundary === "step-up-required" && !session.principal.local) reason = "step_up_required";
    // Privileged ops are remote-safe in protocol when flagged; without the flag
    // remote sessions fail closed as local_only (Tailscale network alone is not auth).
    else if (
      isRemotePrivilegedOperation(operation)
      && !session.principal.local
      && !this.#remotePrivilegedEnabled
    ) {
      reason = "local_only";
    } else {
      if (policy.auditable) this.#appendAudit(operation, "allowed", session, session.principal.local);
      return { allowed: true, session };
    }
    if (policy.auditable) this.#appendAudit(operation, "denied", session, session.principal.local);
    return { allowed: false, reason };
  }

  /**
   * Owner session may use privileged settings / secrets when local, or when
   * remote privileged is deployment-enabled for remote owners.
   * Server-derived only — never from client headers.
   */
  allowsPrivilegedSettings(session: OfficeAuthSession): boolean {
    if (session.principal.tier !== "owner") return false;
    if (session.principal.local) return true;
    return this.#remotePrivilegedEnabled;
  }

  get remotePrivilegedEnabled(): boolean {
    return this.#remotePrivilegedEnabled;
  }

  effectiveAccess(session: OfficeAuthSession): EffectiveAccess {
    const allowedOperations = (Object.keys(OPERATION_POLICIES) as Operation[]).filter((operation) => {
      const policy = OPERATION_POLICIES[operation];
      if (TIER_RANK[session.principal.tier] < TIER_RANK[policy.minimumTier]) return false;
      if (!session.principal.local) {
        if (policy.boundary === "local-only" || policy.boundary === "step-up-required") return false;
        // Hide privileged ops from remote capability lists unless deployment enables them.
        if (isRemotePrivilegedOperation(operation) && !this.#remotePrivilegedEnabled) return false;
      }
      return true;
    });
    return {
      deviceId: session.principal.id,
      tier: session.principal.tier,
      exposure: session.principal.local ? "loopback" : "tailnet",
      authentication: session.principal.id === "local-desktop"
        ? "desktop-capability"
        : session.principal.local ? "local-cookie" : "device-cookie",
      allowedOperations,
    };
  }

  readAudit(session: OfficeAuthSession): { records: OfficePublicAuditRecord[] } | undefined {
    if (session.principal.tier !== "owner") return undefined;
    this.#appendAudit("audit.read", "allowed", session, session.principal.local);
    return { records: this.#audit.map(publicAuditRecord) };
  }

  listDevices(session: OfficeAuthSession): { devices: DeviceSummary[] } | undefined {
    if (!session.principal.local || session.principal.tier !== "owner") return undefined;
    return { devices: [...this.#devices.values()].map(publicDevice) };
  }

  remoteConfig(session: OfficeAuthSession): { enabled: boolean; origins: readonly string[]; trustedProxyHops: number; devices: DeviceSummary[] } | undefined {
    if (session.principal.id !== "local-desktop" || session.principal.tier !== "owner" || !session.principal.local) return undefined;
    return {
      enabled: this.#remoteTokenDigest !== undefined,
      origins: [...this.#allowedOrigins].filter((origin) => !isLoopbackOrigin(origin) && origin.startsWith("https://")),
      trustedProxyHops: this.#trustedProxyHops,
      devices: [...this.#devices.values()].map(publicDevice),
    };
  }

  async revokeDevice(session: OfficeAuthSession, deviceId: string): Promise<boolean> {
    if (!session.principal.local || session.principal.tier !== "owner") return false;
    const device = this.#devices.get(deviceId);
    if (device === undefined || device.revokedAt !== undefined) return false;
    device.revokedAt = new Date().toISOString();
    if (!await this.#saveDeviceRegistry()) { delete device.revokedAt; return false; }
    for (const [key, stored] of this.#sessions) if (stored.principal.id === deviceId) this.#sessions.delete(key);
    this.#appendAudit("device.revoke", "allowed", session, true, deviceId);
    return true;
  }

  async revoke(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const session = this.authenticate(request);
    const rawToken = readCookie(request.headers.cookie, COOKIE_NAME);
    if (rawToken === undefined || session === undefined) return false;
    if (!session.principal.local) {
      const device = this.#devices.get(session.principal.id);
      if (device === undefined || device.revokedAt !== undefined) return false;
      device.revokedAt = new Date().toISOString();
      if (!await this.#saveDeviceRegistry()) { delete device.revokedAt; return false; }
      for (const [key, stored] of this.#sessions) if (stored.principal.id === device.id) this.#sessions.delete(key);
    }
    const removed = session.principal.local ? this.#sessions.delete(tokenDigest(rawToken)) : true;
    response.setHeader("Set-Cookie", session.principal.local
      ? [expireCookie(COOKIE_NAME, "/")]
      : [expireCookie(COOKIE_NAME, "/"), expireCookie(DEVICE_COOKIE_NAME, "/api/v1/auth/device")]);
    this.#appendAudit("auth.logout", removed ? "allowed" : "denied", session, session?.principal.local ?? false);
    return removed;
  }

  #issueDeviceSession(request: IncomingMessage, response: ServerResponse, device: DeviceRecord): OfficeAuthSession {
    this.#scheduleLastSeen(device);
    const session = this.#issueSession(request, response, {
      id: device.id, tier: device.tier, local: false, deviceName: device.displayName,
    });
    this.#appendAudit("auth.device", "allowed", session, false);
    return session;
  }

  #issueSession(request: IncomingMessage, response: ServerResponse, principal: OfficePrincipal): OfficeAuthSession {
    this.#prune();
    if (this.#sessions.size >= MAX_SESSIONS) this.#dropOldest();
    const rawSessionToken = randomBytes(32).toString("base64url");
    const expiresAtMs = Date.now() + SESSION_TTL_MS;
    const stored: StoredSession = {
      principal: { ...principal }, csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
    };
    this.#sessions.set(tokenDigest(rawSessionToken), stored);
    response.appendHeader("Set-Cookie", serializeSessionCookie(rawSessionToken, request, this.#trustedProxyHops));
    return publicSession(stored);
  }

  #authenticateDeviceCredential(request: IncomingMessage, suppliedToken: string): DeviceRecord | undefined {
    const raw = readCookie(request.headers.cookie, DEVICE_COOKIE_NAME);
    const candidate = raw ?? suppliedToken;
    const separator = candidate.indexOf(".");
    if (separator < 1) return undefined;
    const id = candidate.slice(0, separator);
    const credential = candidate.slice(separator + 1);
    const device = this.#devices.get(id);
    if (device === undefined || device.revokedAt !== undefined || device.expiresAtMs <= Date.now()) return undefined;
    return safeEqual(tokenDigest(credential), device.credentialDigest) ? device : undefined;
  }

  #activeDeviceSession(request: IncomingMessage, deviceId: string): OfficeAuthSession | undefined {
    this.#prune();
    const rawToken = readCookie(request.headers.cookie, COOKIE_NAME);
    if (rawToken === undefined || rawToken.length > 128) return undefined;
    const stored = this.#sessions.get(tokenDigest(rawToken));
    if (stored === undefined || stored.principal.id !== deviceId || stored.expiresAtMs - Date.now() <= SESSION_RENEW_WINDOW_MS) return undefined;
    return publicSession(stored);
  }

  #scheduleLastSeen(device: DeviceRecord): void {
    const now = Date.now();
    const previous = device.lastSeenAt === undefined ? 0 : Date.parse(device.lastSeenAt);
    if (Number.isFinite(previous) && now - previous < LAST_SEEN_WRITE_COOLDOWN_MS) return;
    device.lastSeenAt = new Date(now).toISOString();
    this.#lastSeenDirty = true;
    this.#startLastSeenFlush();
  }

  #startLastSeenFlush(): void {
    if (this.#lastSeenFlush !== undefined) return;
    const flush = this.#flushLastSeen();
    this.#lastSeenFlush = flush;
    void flush.finally(() => {
      if (this.#lastSeenFlush !== flush) return;
      this.#lastSeenFlush = undefined;
      if (this.#lastSeenDirty) this.#startLastSeenFlush();
    });
  }

  async #flushLastSeen(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (this.#lastSeenDirty) {
      this.#lastSeenDirty = false;
      await this.#saveDeviceRegistry();
    }
  }

  #isTrustedSecureProxyRequest(request: IncomingMessage): boolean {
    if (!isLoopbackAddress(request.socket.remoteAddress) || this.#trustedProxyHops < 1) return false;
    return request.headers["x-forwarded-proto"] === "https" && request.headers.forwarded === undefined;
  }

  #consumeRemoteAttempts(request: IncomingMessage, token: string): boolean {
    const client = forwardedClientKey(request.headers["x-forwarded-for"], this.#trustedProxyHops);
    if (client === undefined) return false;
    return this.#consumeAttempt(this.#attempts, "global", MAX_GLOBAL_ATTEMPTS)
      && this.#consumeAttempt(this.#attempts, `client:${client}`, MAX_CLIENT_ATTEMPTS)
      && this.#consumeAttempt(this.#attempts, `credential:${tokenDigest(token).slice(0, 24)}`, MAX_CLIENT_ATTEMPTS);
  }

  #consumeRenewAttempts(request: IncomingMessage, deviceId: string): boolean {
    const client = forwardedClientKey(request.headers["x-forwarded-for"], this.#trustedProxyHops);
    if (client === undefined) return false;
    return this.#consumeAttempt(this.#renewAttempts, "global", MAX_RENEW_GLOBAL_ATTEMPTS)
      && this.#consumeAttempt(this.#renewAttempts, `client:${client}`, MAX_RENEW_CLIENT_ATTEMPTS)
      && this.#consumeAttempt(this.#renewAttempts, `device:${deviceId}`, MAX_RENEW_DEVICE_ATTEMPTS);
  }

  #consumeAttempt(collection: Map<string, AttemptWindow>, key: string, limit: number): boolean {
    const now = Date.now();
    for (const [entryKey, window] of collection) if (window.resetAt <= now) collection.delete(entryKey);
    if (collection.size >= MAX_RATE_LIMIT_KEYS && !collection.has(key)) {
      const oldest = collection.keys().next();
      if (!oldest.done) collection.delete(oldest.value);
    }
    const current = collection.get(key);
    if (current === undefined || current.resetAt <= now) {
      collection.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  }

  #invalidDevice(): DeviceBootstrapResult {
    this.#appendAudit("auth.device", "denied", undefined, false);
    return { outcome: "invalid" };
  }

  #loadDeviceRegistry(): void {
    if (this.#deviceRegistryPath === undefined || this.#remoteTokenDigest === undefined) return;
    if (!existsSync(this.#deviceRegistryPath)) return;
    this.#enrollmentConsumed = true;
    try {
      const parsed = JSON.parse(readFileSync(this.#deviceRegistryPath, "utf8")) as unknown;
      if (!isRecord(parsed)
        || parsed.version !== 1
        || typeof parsed.enrollmentTokenDigest !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(parsed.enrollmentTokenDigest)
        || typeof parsed.enrollmentConsumed !== "boolean"
        || !Array.isArray(parsed.devices)
        || parsed.devices.length > MAX_DEVICES) {
        this.#devices.clear();
        return;
      }
      const devices: DeviceRecord[] = [];
      const deviceIds = new Set<string>();
      for (const raw of parsed.devices) {
        const device = parseStoredDevice(raw);
        if (device === undefined || deviceIds.has(device.id)) {
          this.#devices.clear();
          return;
        }
        deviceIds.add(device.id);
        devices.push(device);
      }
      if (!parsed.enrollmentConsumed && devices.length > 0) {
        this.#devices.clear();
        return;
      }
      if (parsed.enrollmentTokenDigest !== this.#remoteTokenGeneration) {
        this.#resetRegistryGeneration();
        return;
      }
      this.#enrollmentConsumed = parsed.enrollmentConsumed;
      for (const device of devices) this.#devices.set(device.id, device);
    } catch { this.#devices.clear(); }
  }

  #resetRegistryGeneration(): void {
    this.#devices.clear();
    this.#enrollmentConsumed = false;
    this.#saveDeviceRegistrySync();
  }

  #registrySnapshot(): string {
    return JSON.stringify({
      version: 1,
      enrollmentTokenDigest: this.#remoteTokenGeneration,
      enrollmentConsumed: this.#enrollmentConsumed,
      devices: [...this.#devices.values()],
    });
  }

  #saveDeviceRegistry(): Promise<boolean> {
    if (this.#deviceRegistryPath === undefined || this.#remoteTokenDigest === undefined) return Promise.resolve(true);
    const snapshot = this.#registrySnapshot();
    const operation = this.#registryWriteTail.then(async () => await this.#writeDeviceRegistry(snapshot));
    this.#registryWriteTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #writeDeviceRegistry(snapshot: string): Promise<boolean> {
    if (this.#deviceRegistryPath === undefined) return true;
    const temporary = `${this.#deviceRegistryPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const directory = dirname(this.#deviceRegistryPath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(snapshot, { encoding: "utf8" });
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, this.#deviceRegistryPath);
      await chmod(this.#deviceRegistryPath, 0o600);
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      return true;
    } catch {
      if (file !== undefined) try { await file.close(); } catch { /* best effort */ }
      try { await unlink(temporary); } catch { /* best effort */ }
      return false;
    }
  }

  #saveDeviceRegistrySync(): boolean {
    if (this.#deviceRegistryPath === undefined || this.#remoteTokenDigest === undefined) return true;
    const temporary = `${this.#deviceRegistryPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let fileDescriptor: number | undefined;
    try {
      const directory = dirname(this.#deviceRegistryPath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      fileDescriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(fileDescriptor, this.#registrySnapshot(), { encoding: "utf8" });
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporary, this.#deviceRegistryPath);
      chmodSync(this.#deviceRegistryPath, 0o600);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      return true;
    } catch {
      if (fileDescriptor !== undefined) try { closeSync(fileDescriptor); } catch { /* best effort */ }
      try { unlinkSync(temporary); } catch { /* best effort */ }
      // A write failure never expands access. This token generation remains
      // consumed in memory even when durable registry persistence fails.
      return false;
    }
  }

  #authenticateDesktop(request: IncomingMessage): OfficeAuthSession | undefined {
    if (this.#desktopCapabilityDigest === undefined || this.#desktopSession === undefined) return undefined;
    if (!isTrustedDesktopRequest(request, this.#desktopOrigins)) return undefined;
    const supplied = readDesktopCapability(request);
    if (supplied === undefined || !isValidDesktopCapability(supplied)) return undefined;
    return safeBufferEqual(secretDigest(supplied), this.#desktopCapabilityDigest)
      ? { ...this.#desktopSession, principal: { ...this.#desktopSession.principal }, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() }
      : undefined;
  }

  #appendAudit(operation: string, outcome: OfficeAuditRecord["outcome"], session: OfficeAuthSession | undefined, local: boolean, deviceId?: string): void {
    const principal = session?.principal;
    const record: OfficeAuditRecord = {
      id: `audit-${randomBytes(8).toString("hex")}`, occurredAt: new Date().toISOString(), operation, outcome,
      actorId: principal?.id ?? null, deviceId: deviceId ?? principal?.id ?? null,
      deviceName: principal?.deviceName ?? null, local,
    };
    this.#audit.push(record);
    if (this.#audit.length > MAX_AUDIT_RECORDS) this.#audit.shift();
    try { this.#onAudit?.({ ...record }); } catch { /* observers cannot affect access control */ }
  }

  #prune(): void {
    const now = Date.now();
    for (const [key, session] of this.#sessions) if (session.expiresAtMs <= now) this.#sessions.delete(key);
  }
  #dropOldest(): void { const first = this.#sessions.keys().next(); if (!first.done) this.#sessions.delete(first.value); }
}

function publicDevice(device: DeviceRecord): DeviceSummary {
  return { id: device.id, displayName: device.displayName, tier: device.tier, createdAt: device.createdAt,
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }) };
}
function publicAuditRecord(record: OfficeAuditRecord): OfficePublicAuditRecord {
  return { occurredAt: record.occurredAt, operation: record.operation, outcome: record.outcome, deviceName: record.deviceName, local: record.local };
}
function publicSession(session: StoredSession): OfficeAuthSession {
  return { principal: { ...session.principal }, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}
function serializeSessionCookie(token: string, request: IncomingMessage, proxyHops: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}${isSecureRequest(request, proxyHops) ? "; Secure" : ""}`;
}
function serializeDeviceCookie(token: string, request: IncomingMessage, proxyHops: number): string {
  return `${DEVICE_COOKIE_NAME}=${token}; Path=/api/v1/auth/device; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(DEVICE_TTL_MS / 1_000)}${isSecureRequest(request, proxyHops) ? "; Secure" : ""}`;
}
function expireCookie(name: string, path: string): string { return `${name}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0`; }
function isSecureRequest(request: IncomingMessage, proxyHops: number): boolean {
  return ("encrypted" in request.socket && request.socket.encrypted === true)
    || (proxyHops > 0 && isLoopbackAddress(request.socket.remoteAddress) && request.headers["x-forwarded-proto"] === "https");
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 4_096) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}
function tokenDigest(token: string): string { return createHash("sha256").update(token).digest("base64url"); }
function secretDigest(token: string): Buffer { return createHash("sha256").update(token, "utf8").digest(); }
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function safeBufferEqual(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }
function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = value?.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}
function forwardedClientKey(header: string | string[] | undefined, trustedHops: number): string | undefined {
  if (trustedHops < 1 || typeof header !== "string" || header.length > 1_024) return undefined;
  const chain = header.split(",").map((part) => part.trim()).filter(Boolean);
  if (chain.length < trustedHops) return undefined;
  const raw = chain[chain.length - trustedHops]!;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(raw);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(raw);
  const value = bracketed?.[1] ?? ipv4WithPort?.[1] ?? raw;
  return value.length <= 64 && isIP(value) !== 0 ? value.toLowerCase() : undefined;
}
function isTrustedLocalRequest(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  const canonical = normalizeOrigin(origin);
  if (!isLoopbackAddress(request.socket.remoteAddress) || canonical === "" || !isTrustedLocalOrigin(canonical) || !isTrustedLocalHost(request.headers.host)) return false;
  return request.headers.forwarded === undefined && request.headers["x-forwarded-for"] === undefined && request.headers["x-forwarded-host"] === undefined && request.headers["x-real-ip"] === undefined;
}
function isTrustedDesktopRequest(request: IncomingMessage, allowedOrigins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  const canonical = normalizeOrigin(origin);
  if (!isLoopbackAddress(request.socket.remoteAddress) || canonical === "" || !allowedOrigins.has(canonical) || !isTrustedLocalHost(request.headers.host)) return false;
  return request.headers.forwarded === undefined && request.headers["x-forwarded-for"] === undefined && request.headers["x-forwarded-host"] === undefined && request.headers["x-real-ip"] === undefined;
}
function validateDesktopOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const canonical = normalizeOrigin(value);
    if (canonical === "" || !isTrustedLocalOrigin(canonical)) throw new Error("Desktop origins must be explicit trusted local origins.");
    origins.add(canonical);
  }
  if (origins.size === 0) throw new Error("At least one desktop origin is required.");
  return origins;
}
function validateAllowedOrigins(values: readonly string[] | undefined): ReadonlySet<string> {
  if (values === undefined || values.length === 0) return new Set<string>();
  const origins = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
      throw new Error(`Configured origin at index ${index} is invalid.`);
    }
    const canonicalLocal = normalizeOrigin(value);
    if (canonicalLocal !== "" && isTrustedLocalOrigin(canonicalLocal)) {
      if (canonicalLocal === "tauri://localhost") { origins.add(canonicalLocal); }
      else { origins.add(new URL(canonicalLocal).origin); }
      continue;
    }
    // Port-bearing Tauri bridge variants are not valid remote HTTPS origins.
    if (isSpecialTauriBridge(value)) { throw new Error(`Configured origin at index ${index} must be an exact portless Tauri bridge origin.`); }
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error(`Configured origin at index ${index} is not a valid URL.`); }
    if (url.protocol !== "https:") { throw new Error(`Configured origin at index ${index} must use HTTPS.`); }
    if (url.username !== "" || url.password !== "") { throw new Error(`Configured origin at index ${index} must not contain credentials.`); }
    if (url.pathname !== "/") { throw new Error(`Configured origin at index ${index} must not contain a path.`); }
    if (url.search !== "" || url.hash !== "") { throw new Error(`Configured origin at index ${index} must not contain query or fragment.`); }
    if (url.hostname === "" || url.hostname.endsWith(".")) { throw new Error(`Configured origin at index ${index} has an invalid hostname.`); }
    if (isIP(url.hostname) !== 0) { throw new Error(`Configured origin at index ${index} must be a hostname, not an IP address.`); }
    if (!isValidHostname(url.hostname)) { throw new Error(`Configured origin at index ${index} has an invalid hostname.`); }
    origins.add(url.origin);
  }
  return origins;
}
function isSpecialTauriBridge(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.port === "") return false;
    const hostname = url.hostname.toLowerCase();
    if (url.protocol === "tauri:") return hostname === "localhost";
    if (url.protocol === "http:" || url.protocol === "https:") return hostname === "tauri.localhost";
    return false;
  } catch {
    return false;
  }
}
function readDesktopCapability(request: IncomingMessage): string | undefined {
  const header = request.headers[DESKTOP_CAPABILITY_HEADER];
  if (typeof header === "string") return header;
  const protocol = request.headers["sec-websocket-protocol"];
  if (typeof protocol !== "string" || protocol.length > 512) return undefined;
  for (const candidate of protocol.split(",").map((value) => value.trim())) if (candidate.startsWith(DESKTOP_PROTOCOL_PREFIX)) return candidate.slice(DESKTOP_PROTOCOL_PREFIX.length);
  return undefined;
}
function isValidDesktopCapability(value: string): boolean { return value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value); }
function isValidHostname(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253) return false;
  for (const label of hostname.split(".")) {
    if (label.length < 1 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    for (let i = 0; i < label.length; i += 1) {
      const code = label.charCodeAt(i);
      if (code === 45) continue; // hyphen
      if (code >= 48 && code <= 57) continue; // 0-9
      if (code >= 65 && code <= 90) continue; // A-Z
      if (code >= 97 && code <= 122) continue; // a-z
      return false;
    }
  }
  return true;
}
function isTrustedLocalHost(value: string | undefined): boolean {
  if (value === undefined || value.length > 256) return false;
  try {
    const parsed = new URL(`http://${value}`);
    return (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      ["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}
function normalizeDeviceName(value: string): string | undefined { const name = value.trim(); return name.length >= 1 && name.length <= 64 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined; }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number { return value === undefined || !Number.isInteger(value) || value < min || value > max ? fallback : value; }
function normalizeRegistryPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || value.includes("\0") || value.length > 4_096) throw new Error("Device registry path must be an absolute safe path.");
  return value;
}
function parseStoredDevice(value: unknown): DeviceRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || !/^device-[a-f0-9]{24}$/.test(value.id)) return undefined;
  if (typeof value.displayName !== "string" || normalizeDeviceName(value.displayName) === undefined) return undefined;
  if (!isPermissionTier(value.tier) || typeof value.credentialDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.credentialDigest)) return undefined;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return undefined;
  if (typeof value.expiresAtMs !== "number" || !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs <= 0) return undefined;
  if (value.lastSeenAt !== undefined && (typeof value.lastSeenAt !== "string" || Number.isNaN(Date.parse(value.lastSeenAt)))) return undefined;
  if (value.revokedAt !== undefined && (typeof value.revokedAt !== "string" || Number.isNaN(Date.parse(value.revokedAt)))) return undefined;
  return {
    id: value.id, displayName: value.displayName, tier: value.tier, credentialDigest: value.credentialDigest,
    createdAt: value.createdAt, expiresAtMs: value.expiresAtMs,
    ...(value.lastSeenAt === undefined ? {} : { lastSeenAt: value.lastSeenAt as string }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt as string }),
  };
}
function isPermissionTier(value: unknown): value is PermissionTier { return value === "viewer" || value === "operator" || value === "manager" || value === "owner"; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
