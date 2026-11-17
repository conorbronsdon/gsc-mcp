export class GSCAPIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string,
  ) {
    super(`GSC API error (${statusCode}) at ${endpoint}: ${message}`);
    this.name = "GSCAPIError";
  }
}

export class AuthError extends GSCAPIError {
  constructor(endpoint: string, detail?: string) {
    super(
      401,
      detail ||
        "Google rejected the credential. The saved OAuth token may be revoked or " +
          "for the wrong account. Re-mint it with the installed-app OAuth flow " +
          "described in the README's Authentication section.",
      endpoint,
    );
    this.name = "AuthError";
  }
}

export class ScopeError extends GSCAPIError {
  constructor(endpoint: string) {
    super(
      403,
      "This tool needs the full https://www.googleapis.com/auth/webmasters scope, " +
        "but the saved credential only has webmasters.readonly. Re-run " +
        "the OAuth consent flow requesting the full webmasters scope, then click " +
        "through consent again. Read-only tools keep working with the old file.",
      endpoint,
    );
    this.name = "ScopeError";
  }
}

export class PermissionError extends GSCAPIError {
  constructor(endpoint: string, siteUrl: string) {
    super(
      403,
      `The signed-in Google account does not have access to "${siteUrl}" in ` +
        "Search Console, or the property is not verified. Add it as a property " +
        "(Domain property via DNS TXT is recommended) and verify it first.",
      endpoint,
    );
    this.name = "PermissionError";
  }
}

export class RateLimitError extends GSCAPIError {
  constructor(endpoint: string) {
    super(
      429,
      "Rate limited by Google Search Console. Wait a bit and retry, or reduce " +
        "rowLimit / the date range on your query.",
      endpoint,
    );
    this.name = "RateLimitError";
  }
}

export class NotFoundError extends GSCAPIError {
  /**
   * @param identifier the property (site URL) or, with `sitemapOf`, the sitemap
   *   feedpath that was not found.
   * @param sitemapOf when set, the 404 is for a sitemap within this property.
   */
  constructor(endpoint: string, identifier: string, sitemapOf?: string) {
    super(
      404,
      sitemapOf !== undefined
        ? `Sitemap "${identifier}" was not found in property "${sitemapOf}". ` +
            `Check the exact sitemap URL with gsc_list_sitemaps.`
        : `"${identifier}" was not found. Check the property URL (e.g. ` +
            `sc-domain:example.com or https://example.com/) and that it is verified ` +
            `in Search Console.`,
      endpoint,
    );
    this.name = "NotFoundError";
  }
}

/**
 * Why a credential file could not be loaded: absent, unreadable, not JSON, or
 * JSON without the refresh_token / client_id / client_secret fields.
 */
export type CredentialProblem = "missing" | "unreadable" | "invalid-json" | "incomplete";

const MINT_REMEDY =
  "Mint one by running the OAuth flow for the webmasters scope — see the " +
  "README. It opens a browser for a single consent click.";

/**
 * Thrown when the credential file is absent or unusable. Surfaced per-tool.
 * Without a `problem` it reports a missing file (the original message).
 */
export class CredentialMissingError extends Error {
  constructor(path: string, problem: CredentialProblem = "missing") {
    const what: Record<CredentialProblem, string> = {
      missing: `Google Search Console credential not found at ${path}.`,
      unreadable: `Google Search Console credential at ${path} could not be read as a file. Check that the path names a file (not a directory) and that this process has permission to read it, or replace it.`,
      "invalid-json": `Google Search Console credential at ${path} is not valid JSON.`,
      incomplete:
        `Google Search Console credential at ${path} is missing refresh_token, ` +
        "client_id or client_secret. If this is the OAuth client file you " +
        "downloaded (client_secret.json), it is the input to the OAuth flow, not " +
        "the minted credential.",
    };
    super(`${what[problem]} ${MINT_REMEDY}`);
    this.name = "CredentialMissingError";
  }
}
