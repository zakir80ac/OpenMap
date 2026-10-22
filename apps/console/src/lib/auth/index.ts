// REQ-SEC-001 — barrel for the console's browser-side OIDC client.
export { AuthProvider, CallbackError, useAuth, useCan, type AsyncAction, type AuthProviderProps, type AuthReason, type AuthStatus, type AuthUser, type AuthValue, type CallbackErrorCode } from './AuthProvider';
export { authConfig, callbackRoute, callbackUri, isCallbackRoute, type ConsoleAuthConfig } from './config';
export { loadDiscovery, resetDiscoveryCache, type FetchLike } from './discovery';
export * from './oidc';
export * from './pkce';
export { effectiveRoles, hasRole, isRole } from './roles';
export { clearPending, readPending, readRefreshToken, savePending, writeRefreshToken, type PendingAuth } from './storage';
export { exchangeCode, refreshGrant, TokenRequestError, type ExchangeCodeRequest, type RefreshRequest } from './token-client';
