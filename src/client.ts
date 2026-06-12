import type { GoogleAuth } from "./auth.js";
import {
  AuthError,
  GSCAPIError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ScopeError,
} from "./errors.js";
import type {
  DimensionFilterGroup,
  SearchAnalyticsResponse,
  SitemapResource,
  SitemapsListResponse,
  SitesListResponse,
  UrlInspectionResponse,
} from "./types.js";

const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const INSPECTION_BASE = "https://searchconsole.googleapis.com/v1";
const VERSION = "0.1.0";

/**
 * Client for the Google Search Console API. Read methods hit the documented
 * webmasters v3 + URL Inspection v1 routes; write methods (sitemap submit/delete)
 * need the full webmasters scope. All auth is via a bearer access token minted
 * from the shared refresh-token credential.
 */
export class GSCClient {
  constructor(private auth: GoogleAuth) {}

  private async request<T>(
    method: string,
    url: string,
    opts: { body?: unknown } = {},
  ): Promise<T> {
    const endpoint = new URL(url).pathname;
    const token = await this.auth.getAccessToken();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": `gsc-mcp/${VERSION}`,
          ...(opts.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (err) {
      throw new GSCAPIError(
        0,
        `Network error reaching Google: ${
          err instanceof Error ? err.message : String(err)
        }`,
        endpoint,
      );
    }

    if (response.status === 401) {
      throw new AuthError(endpoint);
    }
    if (response.status === 429) {
      throw new RateLimitError(endpoint);
    }
    if (response.status === 404) {
      throw new NotFoundError(endpoint, endpoint);
    }
    if (response.status === 403) {
      // 403 means either a missing OAuth scope or no permission on the property.
      // The credential's scopes tell us which: if the write scope is absent and
      // this was a write call, it is almost certainly a scope problem.
      const text = await response.text().catch(() => "");
      if (/insufficient.*scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
        throw new ScopeError(endpoint);
      }
      throw new PermissionError(endpoint, endpoint);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "unknown error");
      throw new GSCAPIError(response.status, body.slice(0, 500), endpoint);
    }

    // DELETE returns an empty body on success.
    if (response.status === 204 || method === "DELETE") {
      return {} as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private static encodeSite(siteUrl: string): string {
    return encodeURIComponent(siteUrl);
  }

  /** GET /sites — verified properties for the signed-in account. */
  async listSites(): Promise<SitesListResponse> {
    return this.request<SitesListResponse>("GET", `${WEBMASTERS_BASE}/sites`);
  }

  /** POST /sites/{siteUrl}/searchAnalytics/query */
  async searchAnalytics(args: {
    siteUrl: string;
    startDate: string;
    endDate: string;
    dimensions?: string[];
    rowLimit?: number;
    startRow?: number;
    dimensionFilterGroups?: DimensionFilterGroup[];
    type?: string;
  }): Promise<SearchAnalyticsResponse> {
    const body: Record<string, unknown> = {
      startDate: args.startDate,
      endDate: args.endDate,
    };
    if (args.dimensions?.length) body.dimensions = args.dimensions;
    if (args.rowLimit !== undefined) body.rowLimit = args.rowLimit;
    if (args.startRow !== undefined) body.startRow = args.startRow;
    if (args.dimensionFilterGroups?.length)
      body.dimensionFilterGroups = args.dimensionFilterGroups;
    if (args.type) body.type = args.type;

    return this.request<SearchAnalyticsResponse>(
      "POST",
      `${WEBMASTERS_BASE}/sites/${GSCClient.encodeSite(
        args.siteUrl,
      )}/searchAnalytics/query`,
      { body },
    );
  }

  /** GET /sites/{siteUrl}/sitemaps */
  async listSitemaps(siteUrl: string): Promise<SitemapsListResponse> {
    return this.request<SitemapsListResponse>(
      "GET",
      `${WEBMASTERS_BASE}/sites/${GSCClient.encodeSite(siteUrl)}/sitemaps`,
    );
  }

  /** GET /sites/{siteUrl}/sitemaps/{feedpath} */
  async getSitemap(siteUrl: string, feedpath: string): Promise<SitemapResource> {
    return this.request<SitemapResource>(
      "GET",
      `${WEBMASTERS_BASE}/sites/${GSCClient.encodeSite(
        siteUrl,
      )}/sitemaps/${GSCClient.encodeSite(feedpath)}`,
    );
  }

  /** PUT /sites/{siteUrl}/sitemaps/{feedpath} — write, needs full webmasters scope. */
  async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
    if (!this.auth.hasWriteScope()) {
      throw new ScopeError(`PUT /sites/${siteUrl}/sitemaps`);
    }
    await this.request<void>(
      "PUT",
      `${WEBMASTERS_BASE}/sites/${GSCClient.encodeSite(
        siteUrl,
      )}/sitemaps/${GSCClient.encodeSite(feedpath)}`,
    );
  }

  /** DELETE /sites/{siteUrl}/sitemaps/{feedpath} — write, needs full webmasters scope. */
  async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
    if (!this.auth.hasWriteScope()) {
      throw new ScopeError(`DELETE /sites/${siteUrl}/sitemaps`);
    }
    await this.request<void>(
      "DELETE",
      `${WEBMASTERS_BASE}/sites/${GSCClient.encodeSite(
        siteUrl,
      )}/sitemaps/${GSCClient.encodeSite(feedpath)}`,
    );
  }

  /** POST /urlInspection/index:inspect (URL Inspection API v1). */
  async inspectUrl(args: {
    siteUrl: string;
    inspectionUrl: string;
    languageCode?: string;
  }): Promise<UrlInspectionResponse> {
    const body: Record<string, unknown> = {
      siteUrl: args.siteUrl,
      inspectionUrl: args.inspectionUrl,
    };
    if (args.languageCode) body.languageCode = args.languageCode;
    return this.request<UrlInspectionResponse>(
      "POST",
      `${INSPECTION_BASE}/urlInspection/index:inspect`,
      { body },
    );
  }
}
