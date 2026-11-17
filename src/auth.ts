import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AuthError,
  CredentialMissingError,
  type CredentialProblem,
} from "./errors.js";

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
   * is absent or unusable, so the server can start keyless and report the gap
   * per-tool. {@link GoogleAuth.check} says which of those it was.
   */
  static tryLoad(path: string = DEFAULT_CREDENTIAL_PATH): GoogleAuth | null {
    const result = GoogleAuth.load(path);
    return "auth" in result ? result.auth : null;
  }

  /**
   * Read the credential once and return either the loaded auth or why it could
   * not be loaded. The standalone server calls this once at startup, so its
   * warning and per-tool error agree; a file fixed later takes effect on
   * restart. Library callers should use this rather than tryLoad() + check(),
   * which read the file twice.
   */
  static load(
    path: string = DEFAULT_CREDENTIAL_PATH,
  ): { auth: GoogleAuth } | { problem: CredentialProblem } {
    const result = GoogleAuth.read(path);
    return "cred" in result ? { auth: new GoogleAuth(result.cred) } : result;
  }

  /**
   * Why the credential at `path` cannot be loaded, or null when it can. Lets a
   * caller tell "no file" apart from "a file that is not a usable credential"
   * (malformed JSON, or the OAuth client file saved in place of the token).
   */
  static check(path: string = DEFAULT_CREDENTIAL_PATH): CredentialProblem | null {
    const result = GoogleAuth.load(path);
    return "problem" in result ? result.problem : null;
  }

  private static read(
    path: string,
  ): { cred: StoredCredential } | { problem: CredentialProblem } {
    // One read, classified by its error code. A separate existsSync check would
    // race a file being rewritten in place and mislabel it "unreadable".
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      return { problem: code === "ENOENT" ? "missing" : "unreadable" };
    }
    let parsed: StoredCredential;
    try {
      parsed = JSON.parse(raw) as StoredCredential;
    } catch {
      return { problem: "invalid-json" };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.refresh_token ||
      !parsed.client_id ||
      !parsed.client_secret
    ) {
      return { problem: "incomplete" };
    }
    return { cred: parsed };
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
    const body = new URLSearchParams({
      client_id: this.cred.client_id!,
      client_secret: this.cred.client_secret!,
      refresh_token: this.cred.refresh_token!,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await fetch(this.cred.token_uri || TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (err) {
      throw new AuthError(
        TOKEN_ENDPOINT,
        `Network error refreshing the access token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AuthError(
        TOKEN_ENDPOINT,
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
      throw new AuthError(TOKEN_ENDPOINT, "Token endpoint returned no access_token.");
    }
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}

export { CredentialMissingError };
