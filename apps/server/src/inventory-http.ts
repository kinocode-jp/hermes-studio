import type { OfficeInventoryKind, ProtocolError } from "@hermes-studio/protocol";
import type { HermesRuntimeSource } from "./hermes-backend.js";
import { InventoryCursorError } from "./hermes-inventory.js";

export type InventoryHttpResult = { status: number; body: unknown };

export async function routeInventoryHttp(source: HermesRuntimeSource | undefined, requestUrl: URL): Promise<InventoryHttpResult> {
  if (source?.inventoryPage === undefined) return failure(503, "runtime_unavailable", "Hermes inventory is unavailable.");
  const allowed = new Set(["kind", "cursor", "limit"]);
  if ([...requestUrl.searchParams.keys()].some((key) => !allowed.has(key))
    || ["kind", "cursor", "limit"].some((key) => requestUrl.searchParams.getAll(key).length > 1)) {
    return failure(400, "bad_request", "Inventory query is invalid.");
  }
  const kind = requestUrl.searchParams.get("kind");
  const cursor = requestUrl.searchParams.get("cursor");
  const limitText = requestUrl.searchParams.get("limit") ?? "100";
  if ((kind !== "profiles" && kind !== "sessions") || cursor === null || cursor.length > 256 || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText)) {
    return failure(400, "bad_request", "Inventory continuation is invalid.");
  }
  try {
    return { status: 200, body: await source.inventoryPage(kind as OfficeInventoryKind, cursor, Number(limitText)) };
  } catch (error) {
    if (error instanceof InventoryCursorError) return failure(409, "conflict", error.message);
    return failure(502, "runtime_unavailable", "Hermes inventory is unavailable.");
  }
}

function failure(status: number, code: ProtocolError["code"], message: string): InventoryHttpResult {
  return { status, body: { code, message, retryable: false } satisfies ProtocolError };
}
