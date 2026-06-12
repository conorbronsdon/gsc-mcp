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
        "Google rejected the credential. The OAuth token at " +
          "~/.config/gws/searchconsole_credentials.json may be revoked or for the " +
          "wrong account. Re-mint it with scripts/seo-auth-setup.py.",
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
        "scripts/seo-auth-setup.py (in cot-production) to upgrade the credential, " +
        "then click through consent again. Read-only tools keep working with the old file.",
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
  constructor(endpoint: string, identifier: string) {
    super(
      404,
      `"${identifier}" was not found. Check the property URL (e.g. ` +
        `sc-domain:example.com or https://example.com/) and that it is verified ` +
        `in Search Console.`,
      endpoint,
    );
    this.name = "NotFoundError";
  }
}

/** Thrown when the credential file is absent or unreadable. Surfaced per-tool. */
export class CredentialMissingError extends Error {
  constructor(path: string) {
    super(
      `Google Search Console credential not found at ${path}. ` +
        "Mint it once with: python scripts/seo-auth-setup.py (in the cot-production " +
        "repo) — it opens a browser for one consent click. The same file is shared " +
        "with the SEO snapshot script.",
    );
    this.name = "CredentialMissingError";
  }
}
