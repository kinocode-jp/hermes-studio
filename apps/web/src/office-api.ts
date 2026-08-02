export { subscribeOfficeSessionSynchronizations } from "./office-synchronization";
export {
  DeviceRevokeError,
  OfficeDeviceAuthRequiredError,
  OfficeHttpError,
  OfficeRemoteConfigError,
  OfficeSessionUnavailableError,
  REMOTE_PROXY_CONFIGURATION_MESSAGE,
  isOfficeSnapshot,
  shouldRecoverOfficeWebSocket,
  type DeviceLoginResult,
  type DeviceRevokeFailureCode,
  type OfficeApiCallbacks,
  type OfficeApiConnection,
  type OfficeApiRequestOptions,
  type OfficeEvent,
  type OfficeWebSocketLease,
  type RemoteConfigFailureCode,
} from "./office-api-types";
export {
  authenticateRemoteDevice,
  fetchRemoteConfigStatus,
  logoutRemoteDevice,
  officeFetchJson,
  studioServerUrl,
  openOfficeWebSocket,
  recoverOfficeWebSocketAuthentication,
  revokeRemoteDevice,
  subscribeOfficeAuthChanges,
} from "./office-api-session";
export { connectOfficeApi } from "./office-api-connection";
