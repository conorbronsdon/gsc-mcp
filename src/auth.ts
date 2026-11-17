import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthError, CredentialMissingError } from "./errors.js";

/**
 * An OAuth user credential for the Search Console API, in google-auth's saved-token
 * format. See the README for how to mint one.
 * It is google-auth's `Credentials.to_json()` shape: an installed-app OAuth token
 * with a long-lived refresh_token. The Python SEO snapshot script reads the same
 * file, so one OAuth mint serves both the script and this MCP server.
 */
export const DEFAULT_CREDENTIAL_PATH = join(
  homedir(),
  ".config",
  "gws",
  "searchconsole_credentials.json",
);

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The only URLs allowed to receive the refresh grant. google-auth writes the
 * first; the other two are legacy endpoints older credential files carry.
 */
const TOKEN_ENDPOINTS = new Set([
  TOKEN_ENDPOINT,
  "https://accounts.google.com/o/oauth2/token",
  "https://www.googleapis.com/oauth2/v4/token",
]);

/**
 * The URL the refresh grant (client_secret + refresh_token) is posted to.
 * `token_uri` comes from the credential file; it is honoured only when it is
 * exactly one of `TOKEN_ENDPOINTS` (no query, fragment or userinfo), so an edited or copied file cannot send the
 * refresh token to another host.
 */
export function resolveTokenEndpoint(tokenUri: string | undefined): string {
  if (!tokenUri) return TOKEN_ENDPOINT;
  let url: URL;
  try {
    url = new URL(tokenUri);
  } catch {
    throw new AuthError(
      TOKEN_ENDPOINT,
      "The credential's token_uri is not a valid URL. Set it to " +
        `${TOKEN_ENDPOINT} or remove it.`,
    );
  }
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`;
  if (!TOKEN_ENDPOINTS.has(endpoint) || url.username || url.password || url.search || url.hash) {
    throw new AuthError(
      TOKEN_ENDPOINT,
      `The credential's token_uri points at ${endpoint}, which is ` +
        "not a Google OAuth token endpoint, so the refresh token was not sent. Set " +
        `token_uri to ${TOKEN_ENDPOINT} or remove it.`,
    );
  }
  return endpoint;
}

/** The subset of google-auth's to_json() output that we need. */
interface StoredCredential {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token?: string; // last access token (may be expired)
  scopes?: string[];
  // google-auth also writes: token_uri, expiry, account, universe_domain, type
  token_uri?: string;
}

/**
 * Holds the OAuth refresh token and mints short-lived access tokens against
 * Google's token endpoint with plain fetch — no googleapis / google-auth-library
 * dependency. Access tokens are cached in memory until shortly before expiry.
 */
export class GoogleAuth {
  private cred: StoredCredential;
  private accessToken: string | null = null;
  private expiresAt = 0; // epoch ms

  private constructor(cred: StoredCredential) {
    this.cred = cred;
  }

  /**
   * Load the credential from disk. Returns null (does not throw) when the file
   * is absent, so the server can start keyless and report the gap per-tool.
   */
  static tryLoad(path: string = DEFAULT_CREDENTIAL_PATH): GoogleAuth | null {
    if (!existsSync(path)) return null;
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    let parsed: StoredCredential;
    try {
      parsed = JSON.parse(raw) as StoredCredential;
    } catch {
      return null;
    }
    if (!parsed.refresh_token || !parsed.client_id || !parsed.client_secret) {
      return null;
    }
    return new GoogleAuth(parsed);
  }

  /** Scopes recorded in the credential file (best-effort; may be absent). */
  get scopes(): string[] {
    return this.cred.scopes ?? [];
  }

  /**
   * True when the saved credential includes the full webmasters write scope.
   * Used to fail fast on write tools before hitting the API. Only `webmasters`
   * authorizes sitemaps.submit / sitemaps.delete; the Site Verification scope
   * does not, so it must not count here.
   */
  hasWriteScope(): boolean {
    return this.scopes.includes("https://www.googleapis.com/auth/webmasters");
  }

  /** Return a valid access token, refreshing via the token endpoint if needed. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken;
    }
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    const endpoint = resolveTokenEndpoint(this.cred.token_uri);
    const body = new URLSearchParams({
      client_id: this.cred.client_id!,
      client_secret: this.cred.client_secret!,
      refresh_token: this.cred.refresh_token!,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw new AuthError(
        endpoint,
        `Network error refreshing the access token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AuthError(
        endpoint,
        `Token refresh failed (HTTP ${response.status}). The refresh token may be ` +
          `revoked or expired — re-mint it as described in the README's Authentication ` +
          `section. ${text.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new AuthError(endpoint, "Token endpoint returned no access_token.");
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

export { CredentialMissingError };
