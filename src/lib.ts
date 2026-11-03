/**
 * Library entry point for @conorbronsdon/gsc-mcp.
 *
 * The package's binary (`gsc-mcp`, src/index.ts) runs a standalone stdio
 * server. This module exposes the same pieces for embedding: register the
 * Search Console tools on your own McpServer with {@link registerGscTools}, or
 * build the standalone server with {@link createServer}. Importing this module
 * has no side effects; it does not start a transport or read a credential.
 */
export {
  createServer,
  registerGscTools,
  errorResult,
  type RegisterGscToolsOptions,
} from "./server.js";
export { GSCClient } from "./client.js";
export { DEFAULT_CREDENTIAL_PATH, GoogleAuth } from "./auth.js";
export {
  AuthError,
  CredentialMissingError,
  GSCAPIError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ScopeError,
} from "./errors.js";
