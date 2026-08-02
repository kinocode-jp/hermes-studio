import type { OfficeAccessState } from "./domain";

export type OfficeClientLocation = {
  protocol: string;
  hostname: string;
};

export type DeviceLoginFailureCode = "invalid" | "rate-limited" | "disabled" | "unavailable";

export type DeviceLoginFailure = {
  code: DeviceLoginFailureCode;
  message: string;
  retryAfterSeconds?: number;
};

export function isLocalOfficeClient(location: OfficeClientLocation): boolean {
  return location.protocol === "tauri:"
    || location.hostname === "tauri.localhost"
    || location.hostname === "localhost"
    || location.hostname === "127.0.0.1"
    || location.hostname === "::1";
}

export function shouldShowDeviceEnrollmentForm(state: OfficeAccessState): boolean {
  return state === "login-required" || state === "submitting";
}

export function classifyDeviceLoginFailure(status: number, retryAfterHeader: string | null): DeviceLoginFailure {
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);
    return {
      code: "rate-limited",
      message: retryAfterSeconds
        ? `試行回数の上限に達しました。${retryAfterSeconds}秒後にもう一度お試しください。`
        : "試行回数の上限に達しました。しばらく待ってからもう一度お試しください。",
      ...(retryAfterSeconds ? { retryAfterSeconds } : {})
    };
  }
  if (status === 404) {
    return { code: "disabled", message: "このStudio Serverではリモート端末ログインが無効です。" };
  }
  if (status === 400 || status === 401 || status === 403 || status === 413) {
    return { code: "invalid", message: "端末名またはアクセストークンを確認してください。" };
  }
  return { code: "unavailable", message: "Studio Serverへログインできませんでした。接続を確認してください。" };
}

export function normalizeDeviceName(value: string): string | undefined {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 64 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d{1,5}$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600 ? seconds : undefined;
}
