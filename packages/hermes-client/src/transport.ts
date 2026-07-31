import type {
  HermesConnectionState,
  HermesGatewayEvent,
  HermesKnownRpcMethod,
  HermesRpcParams,
  HermesRpcResult,
  JsonObject,
  JsonPrimitive,
  ProfileName
} from './types'

export type HermesHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT'

export interface HermesRequestOptions {
  /** Logical target for process-scoped endpoints; the transport chooses backend routing. */
  profile?: ProfileName
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HermesHttpRequest<TBody = unknown> {
  body?: TBody
  headers?: Readonly<Record<string, string>>
  method: HermesHttpMethod
  path: `/${string}`
  query?: Readonly<Record<string, JsonPrimitive | undefined>>
}

/** Profile routing is explicit; never infer it from the currently selected UI character. */
export type HermesRpcConnectOptions = HermesRequestOptions

export interface HermesStreamRequest {
  /** Examples: /api/plugins/kanban/events and /api/events. */
  path: `/${string}`
  query?: Readonly<Record<string, JsonPrimitive | undefined>>
}

export type HermesGatewayEventListener = (event: HermesGatewayEvent) => void
export type HermesStateListener = (state: HermesConnectionState) => void

export interface HermesSubscription {
  close(): void
  readonly closed: boolean
}

/** One JSON-RPC 2.0 connection to Hermes `/api/ws`. */
export interface HermesRpcConnection extends HermesSubscription {
  readonly state: HermesConnectionState

  request<TMethod extends HermesKnownRpcMethod>(
    method: TMethod,
    params: HermesRpcParams<TMethod>,
    options?: HermesRequestOptions
  ): Promise<HermesRpcResult<TMethod>>

  /** Escape hatch for forward-compatible methods not known by this package version. */
  request<TResult = unknown>(
    method: string,
    params?: JsonObject,
    options?: HermesRequestOptions
  ): Promise<TResult>

  onEvent(listener: HermesGatewayEventListener): () => void
  onState(listener: HermesStateListener): () => void
}

/**
 * Runtime boundary for Hermes Studio.
 *
 * A browser implementation should call the Studio Server, not expose a
 * remote Hermes admin credential directly to JavaScript. Tauri may implement
 * this boundary in Rust while the PWA uses the authenticated Office proxy.
 */
export interface HermesTransport {
  connectRpc(options?: HermesRpcConnectOptions): Promise<HermesRpcConnection>

  request<TResult, TBody = unknown>(
    request: HermesHttpRequest<TBody>,
    options?: HermesRequestOptions
  ): Promise<TResult>

  subscribe<TEvent>(
    request: HermesStreamRequest,
    listener: (event: TEvent) => void,
    options?: HermesRequestOptions
  ): Promise<HermesSubscription>
}

export class HermesTransportError extends Error {
  readonly code?: number | string
  readonly details?: unknown
  readonly status?: number

  constructor(
    message: string,
    options: { cause?: unknown; code?: number | string; details?: unknown; status?: number } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HermesTransportError'
    if (options.code !== undefined) this.code = options.code
    if (options.details !== undefined) this.details = options.details
    if (options.status !== undefined) this.status = options.status
  }
}

export function isMissingHermesRpcMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /method not found|-32601|unknown method|no such method/i.test(message)
}
