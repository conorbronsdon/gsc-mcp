import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GSCClient } from "./client.js";
import { CredentialMissingError } from "./errors.js";
import { round, shapeRow, stripNulls } from "./shape.js";
import type { UrlInspectionResult } from "./types.js";

const json = (data: unknown) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(stripNulls(data), null, 2) },
  ],
});

const errorResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/**
 * Build a complete MCP tool annotation set. The MCP spec lets clients omit any
 * hint, but we set all five explicitly on every tool so a client (or the Glama
 * inspector) can reason about read-vs-write without calling the tool. Defaults
 * here describe a read-only, side-effect-free, idempotent tool; override per tool.
 */
function buildAnnotations(
  title: string,
  overrides: Partial<ToolAnnotations> = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    ...overrides,
  };
}

const STRIKING_POS_MIN = 8.0;
const STRIKING_POS_MAX = 25.0;

export function createServer(client: GSCClient | null): McpServer {
  const server = new McpServer({
    name: "gsc-mcp",
    version: "0.1.0",
  });

  /** Resolve the client or return a per-tool setup error if none is configured. */
  function need(): GSCClient {
    if (!client) {
      throw new CredentialMissingError(
        "~/.config/gws/searchconsole_credentials.json",
      );
    }
    return client;
  }

  /**
   * Wrap a tool handler so any thrown error (missing credential, auth, scope,
   * permission, rate limit) is returned as a clean isError result the agent can
   * read, rather than surfacing as a protocol-level failure.
   */
  function guard<A>(fn: (args: A) => Promise<ReturnType<typeof json>>) {
    return async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    };
  }

  const siteUrlArg = z
    .string()
    .describe(
      "The Search Console property. Use the exact form shown by gsc_list_sites: " +
        "a Domain property is 'sc-domain:example.com'; a URL-prefix property is the " +
        "full origin with a trailing slash, e.g. 'https://example.com/'.",
    );

  // --- gsc_list_sites ---

  server.registerTool(
    "gsc_list_sites",
    {
      title: "List Search Console properties",
      description:
        "List the Search Console properties (sites) the signed-in Google account " +
        "can access, with each one's permission level. This is the entry point: " +
        "every other tool needs a property string in the exact form returned here.",
      inputSchema: {},
      annotations: buildAnnotations("List Search Console properties"),
    },
    guard(async () => {
      const data = await need().listSites();
      const sites = (data.siteEntry ?? []).map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
      }));
      return json({ propertyCount: sites.length, properties: sites });
    }),
  );

  // --- gsc_search_analytics ---

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Query search performance",
      description:
        "Query Search Console search analytics for a property over a date range: " +
        "clicks, impressions, CTR, and average position, grouped by the dimensions " +
        "you pass (query, page, country, device, date). Returns compact rows. Use " +
        "this for 'what are my top queries / pages' and trend questions. GSC data " +
        "lags ~2-3 days, so end your range a few days before today.",
      inputSchema: {
        site_url: siteUrlArg,
        start_date: z
          .string()
          .describe("Start date, YYYY-MM-DD (Pacific Time, inclusive)."),
        end_date: z
          .string()
          .describe("End date, YYYY-MM-DD (Pacific Time, inclusive)."),
        dimensions: z
          .array(z.enum(["query", "page", "country", "device", "date"]))
          .optional()
          .default(["query"])
          .describe(
            "How to group rows. Default ['query']. Combine for breakdowns, " +
              "e.g. ['page','query'].",
          ),
        row_limit: z
          .number()
          .optional()
          .default(25)
          .describe("Max rows to return (default 25, cap 1000). Keep low; rows cost tokens."),
        type: z
          .enum(["web", "news", "image", "video", "discover", "googleNews"])
          .optional()
          .describe("Search type filter. Defaults to web when omitted."),
        dimension_filter_groups: z
          .array(
            z.object({
              groupType: z.enum(["and"]).optional(),
              filters: z.array(
                z.object({
                  dimension: z.enum([
                    "query",
                    "page",
                    "country",
                    "device",
                    "searchAppearance",
                  ]),
                  operator: z
                    .enum([
                      "equals",
                      "notEquals",
                      "contains",
                      "notContains",
                      "includingRegex",
                      "excludingRegex",
                    ])
                    .optional(),
                  expression: z.string(),
                }),
              ),
            }),
          )
          .optional()
          .describe(
            "Optional filters, e.g. only rows where page contains '/blog/'. " +
              "Each group's filters are AND-ed.",
          ),
      },
      annotations: buildAnnotations("Query search performance"),
    },
    guard(async ({
      site_url,
      start_date,
      end_date,
      dimensions,
      row_limit,
      type,
      dimension_filter_groups,
    }) => {
      const cappedLimit = Math.min(Math.max(1, row_limit), 1000);
      const data = await need().searchAnalytics({
        siteUrl: site_url,
        startDate: start_date,
        endDate: end_date,
        dimensions,
        rowLimit: cappedLimit,
        type,
        dimensionFilterGroups: dimension_filter_groups,
      });
      const rows = (data.rows ?? []).map((r) => shapeRow(r, dimensions));
      return json({
        siteUrl: site_url,
        window: { startDate: start_date, endDate: end_date },
        dimensions,
        rowCount: rows.length,
        rows,
      });
    }),
  );

  // --- gsc_striking_distance ---

  server.registerTool(
    "gsc_striking_distance",
    {
      title: "Striking-distance keywords",
      description:
        "The SEO goldmine view: queries ranking just off page one (average " +
        "position 8-25) with enough impressions to be worth optimizing. These are " +
        "the keywords where a small content tweak can win real clicks. Computed " +
        "client-side from search analytics; returns queries sorted by impressions.",
      inputSchema: {
        site_url: siteUrlArg,
        start_date: z
          .string()
          .describe("Start date, YYYY-MM-DD (default: 28 days before end_date if omitted in your call)."),
        end_date: z.string().describe("End date, YYYY-MM-DD (lag ~2-3 days behind today)."),
        min_impressions: z
          .number()
          .optional()
          .default(10)
          .describe("Only include queries with at least this many impressions (default 10)."),
        position_min: z
          .number()
          .optional()
          .default(STRIKING_POS_MIN)
          .describe(`Lower bound of the striking-distance band (default ${STRIKING_POS_MIN}).`),
        position_max: z
          .number()
          .optional()
          .default(STRIKING_POS_MAX)
          .describe(`Upper bound of the striking-distance band (default ${STRIKING_POS_MAX}).`),
        limit: z
          .number()
          .optional()
          .default(25)
          .describe("Max queries to return, ranked by impressions (default 25)."),
      },
      annotations: buildAnnotations("Striking-distance keywords"),
    },
    guard(async ({
      site_url,
      start_date,
      end_date,
      min_impressions,
      position_min,
      position_max,
      limit,
    }) => {
      // Pull a generous page of query rows, then filter to the band client-side.
      const data = await need().searchAnalytics({
        siteUrl: site_url,
        startDate: start_date,
        endDate: end_date,
        dimensions: ["query"],
        rowLimit: 1000,
      });
      const candidates = (data.rows ?? [])
        .map((r) => ({
          query: r.keys?.[0] ?? "",
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: round(r.ctr ?? 0, 4),
          position: round(r.position ?? 0, 1),
        }))
        .filter(
          (r) =>
            r.position >= position_min &&
            r.position <= position_max &&
            r.impressions >= min_impressions,
        )
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, Math.max(1, limit));

      return json({
        siteUrl: site_url,
        window: { startDate: start_date, endDate: end_date },
        band: { positionMin: position_min, positionMax: position_max },
        minImpressions: min_impressions,
        note:
          "Queries ranking just off page one. Improving content/links for these " +
          "is usually the highest-leverage SEO work.",
        count: candidates.length,
        queries: candidates,
      });
    }),
  );

  // --- gsc_list_sitemaps ---

  server.registerTool(
    "gsc_list_sitemaps",
    {
      title: "List sitemaps",
      description:
        "List the sitemaps submitted for a property, with each one's submit/" +
        "download times, pending state, and warning/error counts. Use this to " +
        "check whether a sitemap was processed and is error-free.",
      inputSchema: { site_url: siteUrlArg },
      annotations: buildAnnotations("List sitemaps"),
    },
    guard(async ({ site_url }) => {
      const data = await need().listSitemaps(site_url);
      const sitemaps = (data.sitemap ?? []).map((s) => ({
        path: s.path,
        type: s.type,
        isPending: s.isPending,
        isSitemapsIndex: s.isSitemapsIndex,
        lastSubmitted: s.lastSubmitted,
        lastDownloaded: s.lastDownloaded,
        warnings: s.warnings,
        errors: s.errors,
      }));
      return json({
        siteUrl: site_url,
        sitemapCount: sitemaps.length,
        sitemaps,
      });
    }),
  );

  // --- gsc_submit_sitemap (WRITE) ---

  server.registerTool(
    "gsc_submit_sitemap",
    {
      title: "Submit a sitemap",
      description:
        "Submit (or re-submit) a sitemap to Google Search Console for a property. " +
        "This is a WRITE action: it registers the sitemap and pings Google to crawl " +
        "it. Requires the full webmasters OAuth scope — if the saved credential is " +
        "read-only, re-mint with scripts/seo-auth-setup.py. Idempotent: re-submitting " +
        "the same sitemap URL just refreshes it.",
      inputSchema: {
        site_url: siteUrlArg,
        feedpath: z
          .string()
          .describe(
            "Full URL of the sitemap to submit, e.g. https://example.com/sitemap.xml. " +
              "Must be within the property.",
          ),
      },
      annotations: buildAnnotations("Submit a sitemap", {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      }),
    },
    guard(async ({ site_url, feedpath }) => {
      await need().submitSitemap(site_url, feedpath);
      return json({
        siteUrl: site_url,
        feedpath,
        status: "submitted",
        note: "Google was pinged to crawl this sitemap. Use gsc_list_sitemaps to check processing status (it is not instant).",
      });
    }),
  );

  // --- gsc_delete_sitemap (WRITE, DESTRUCTIVE) ---

  server.registerTool(
    "gsc_delete_sitemap",
    {
      title: "Delete a sitemap",
      description:
        "Remove a sitemap from a property in Search Console. This is a DESTRUCTIVE " +
        "write action: it deregisters the sitemap (it does not delete the file from " +
        "your server, but Google stops tracking it). Requires the full webmasters " +
        "OAuth scope.",
      inputSchema: {
        site_url: siteUrlArg,
        feedpath: z
          .string()
          .describe("Full URL of the sitemap to remove, e.g. https://example.com/sitemap.xml."),
      },
      annotations: buildAnnotations("Delete a sitemap", {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      }),
    },
    guard(async ({ site_url, feedpath }) => {
      await need().deleteSitemap(site_url, feedpath);
      return json({
        siteUrl: site_url,
        feedpath,
        status: "deleted",
        note: "Search Console will stop tracking this sitemap. The file on your server is untouched.",
      });
    }),
  );

  // --- gsc_inspect_url ---

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect a URL's index status",
      description:
        "Inspect a single URL with the URL Inspection API: whether Google has it " +
        "indexed, its coverage state, last crawl time, Google's chosen canonical, " +
        "and a one-line mobile/rich-results summary. Returns a compact projection, " +
        "not the full raw blob. Use this to debug 'why isn't this page indexed'.",
      inputSchema: {
        site_url: siteUrlArg,
        inspection_url: z
          .string()
          .describe("The fully-qualified URL to inspect. Must be within the property."),
        language_code: z
          .string()
          .optional()
          .describe("Optional BCP-47 language code for issue messages, e.g. 'en-US'."),
      },
      annotations: buildAnnotations("Inspect a URL's index status"),
    },
    guard(async ({ site_url, inspection_url, language_code }) => {
      const data = await need().inspectUrl({
        siteUrl: site_url,
        inspectionUrl: inspection_url,
        languageCode: language_code,
      });
      const r: UrlInspectionResult = data.inspectionResult ?? {};
      const idx = r.indexStatusResult ?? {};
      return json({
        inspectedUrl: inspection_url,
        siteUrl: site_url,
        index: {
          verdict: idx.verdict,
          coverageState: idx.coverageState,
          indexingState: idx.indexingState,
          robotsTxtState: idx.robotsTxtState,
          pageFetchState: idx.pageFetchState,
          lastCrawlTime: idx.lastCrawlTime,
          googleCanonical: idx.googleCanonical,
          userCanonical: idx.userCanonical,
          crawledAs: idx.crawledAs,
          sitemap: idx.sitemap,
        },
        mobileUsability: r.mobileUsabilityResult?.verdict,
        richResults: r.richResultsResult?.verdict,
        amp: r.ampResult?.verdict,
        reportLink: r.inspectionResultLink,
      });
    }),
  );

  return server;
}

export { errorResult };
