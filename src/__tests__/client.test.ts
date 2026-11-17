import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "../auth.js";
import { GSCClient } from "../client.js";
import {
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ScopeError,
} from "../errors.js";

/** A stub GoogleAuth that hands out a fixed token and a configurable write scope. */
function fakeAuth(hasWrite = true): GoogleAuth {
  return {
    getAccessToken: async () => "AT",
    hasWriteScope: () => hasWrite,
    get scopes() {
      return [];
    },
  } as unknown as GoogleAuth;
}

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async (): Promise<Response> =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GSCClient.request auth + headers", () => {
  it("sends the bearer access token", async () => {
    const fetchMock = mockFetch(200, { siteEntry: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth());
    await client.listSites();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer AT",
    );
  });

  it("throws AuthError on 401", async () => {
    vi.stubGlobal("fetch", mockFetch(401, "unauthorized"));
    await expect(new GSCClient(fakeAuth()).listSites()).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("AuthError's remedy points at the README, not an unshipped script", async () => {
    vi.stubGlobal("fetch", mockFetch(401, "unauthorized"));
    const err = await new GSCClient(fakeAuth()).listSites().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/README/);
    expect((err as Error).message).not.toMatch(/\.py\b/);
  });

  it("throws RateLimitError on 429", async () => {
    vi.stubGlobal("fetch", mockFetch(429, "slow down"));
    await expect(new GSCClient(fakeAuth()).listSites()).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("throws NotFoundError on 404", async () => {
    vi.stubGlobal("fetch", mockFetch(404, "no such property"));
    await expect(new GSCClient(fakeAuth()).listSites()).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("maps a 403 with insufficient scope to ScopeError", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(403, { error: { message: "Request had insufficient scopes." } }),
    );
    await expect(new GSCClient(fakeAuth()).listSites()).rejects.toBeInstanceOf(
      ScopeError,
    );
  });

  it("maps a plain 403 to PermissionError", async () => {
    vi.stubGlobal("fetch", mockFetch(403, "forbidden"));
    await expect(new GSCClient(fakeAuth()).listSites()).rejects.toBeInstanceOf(
      PermissionError,
    );
  });
});

describe("403/404 messages name the property or sitemap, not the API path (#46)", () => {
  const SITE = "sc-domain:example.com";
  const SITEMAP = "https://example.com/sitemap.xml";
  const SITEMAP_PATH =
    "/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml";

  it("a sitemap 404 names the sitemap and the property, and does not blame verification", async () => {
    vi.stubGlobal("fetch", mockFetch(404, "not found"));
    const err = await new GSCClient(fakeAuth())
      .deleteSitemap(SITE, SITEMAP)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toBe(
      `GSC API error (404) at ${SITEMAP_PATH}: Sitemap "https://example.com/sitemap.xml" ` +
        `was not found in property "sc-domain:example.com". Check the exact sitemap URL ` +
        `with gsc_list_sitemaps.`,
    );
    expect((err as Error).message).not.toMatch(/verified/);
  });

  it("getSitemap and submitSitemap 404s use the same sitemap message", async () => {
    for (const call of [
      (c: GSCClient) => c.getSitemap(SITE, SITEMAP),
      (c: GSCClient) => c.submitSitemap(SITE, SITEMAP),
    ]) {
      vi.stubGlobal("fetch", mockFetch(404, "not found"));
      const err = await call(new GSCClient(fakeAuth())).catch((e: unknown) => e);
      expect((err as Error).message).toContain(
        'Sitemap "https://example.com/sitemap.xml" was not found in property "sc-domain:example.com".',
      );
    }
  });

  it("a property 404 names the decoded site URL", async () => {
    vi.stubGlobal("fetch", mockFetch(404, "not found"));
    const err = await new GSCClient(fakeAuth()).listSitemaps(SITE).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'GSC API error (404) at /webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps: ' +
        '"sc-domain:example.com" was not found. Check the property URL (e.g. ' +
        "sc-domain:example.com or https://example.com/) and that it is verified in Search Console.",
    );
  });

  it("a 403 on search analytics names the decoded site URL", async () => {
    vi.stubGlobal("fetch", mockFetch(403, "forbidden"));
    const err = await new GSCClient(fakeAuth())
      .searchAnalytics({ siteUrl: "https://example.com/", startDate: "2026-05-01", endDate: "2026-05-28" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionError);
    expect((err as Error).message).toBe(
      "GSC API error (403) at /webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query: " +
        'The signed-in Google account does not have access to "https://example.com/" in ' +
        "Search Console, or the property is not verified. Add it as a property " +
        "(Domain property via DNS TXT is recommended) and verify it first.",
    );
  });

  it("a 403 on URL inspection names the site URL, not the inspection endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch(403, "forbidden"));
    const err = await new GSCClient(fakeAuth())
      .inspectUrl({ siteUrl: SITE, inspectionUrl: "https://example.com/page" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('does not have access to "sc-domain:example.com"');
    expect((err as Error).message).not.toContain('access to "/v1/urlInspection');
  });

  it("listSites has no property, so its 404 still names the endpoint", async () => {
    vi.stubGlobal("fetch", mockFetch(404, "not found"));
    const err = await new GSCClient(fakeAuth()).listSites().catch((e: unknown) => e);
    expect((err as Error).message).toContain('"/webmasters/v3/sites" was not found.');
  });
});

describe("GSCClient.searchAnalytics", () => {
  it("POSTs the body and url-encodes the property", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ rows: [{ keys: ["x"], clicks: 1 }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth());
    const res = await client.searchAnalytics({
      siteUrl: "sc-domain:example.com",
      startDate: "2026-05-01",
      endDate: "2026-05-28",
      dimensions: ["query"],
      rowLimit: 25,
    });
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe("POST");
    expect(url).toContain("sc-domain%3Aexample.com");
    expect(url).toContain("/searchAnalytics/query");
    const sent = JSON.parse(String(opts.body));
    expect(sent.startDate).toBe("2026-05-01");
    expect(sent.dimensions).toEqual(["query"]);
    expect(res.rows![0].clicks).toBe(1);
  });
});

describe("GSCClient sitemap writes gate on scope", () => {
  it("submitSitemap throws ScopeError when the credential is read-only", async () => {
    // No fetch call should happen — the scope check fails first.
    const fetchMock = mockFetch(200, {});
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth(false));
    await expect(
      client.submitSitemap("sc-domain:example.com", "https://example.com/sitemap.xml"),
    ).rejects.toBeInstanceOf(ScopeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deleteSitemap throws ScopeError when read-only", async () => {
    vi.stubGlobal("fetch", mockFetch(200, {}));
    const client = new GSCClient(fakeAuth(false));
    await expect(
      client.deleteSitemap("sc-domain:example.com", "https://example.com/sitemap.xml"),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it("submitSitemap PUTs when the write scope is present", async () => {
    const fetchMock = mockFetch(200, "");
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth(true));
    await client.submitSitemap("sc-domain:example.com", "https://example.com/sitemap.xml");
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe("PUT");
    expect(url).toContain("/sitemaps/");
  });

  it("deleteSitemap DELETEs and tolerates an empty body", async () => {
    // 204 No Content cannot carry a body in undici's Response.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth(true));
    await client.deleteSitemap("sc-domain:example.com", "https://example.com/sitemap.xml");
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe("DELETE");
  });
});

describe("GSCClient sitemap writes with a real GoogleAuth (issue #45)", () => {
  function loadAuth(scopes: string[]): { auth: GoogleAuth; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "gsc-scope-"));
    const path = join(dir, "cred.json");
    writeFileSync(
      path,
      JSON.stringify({
        client_id: "example-client-id",
        client_secret: "example-client-secret",
        refresh_token: "example-refresh-token",
        scopes,
      }),
    );
    return { auth: GoogleAuth.tryLoad(path)!, dir };
  }

  it("readonly + siteverification: submitSitemap throws ScopeError before any fetch", async () => {
    const fetchMock = mockFetch(200, { access_token: "example-at", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);
    const { auth, dir } = loadAuth([
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/siteverification",
    ]);
    const err = await new GSCClient(auth)
      .submitSitemap("sc-domain:example.com", "https://example.com/sitemap.xml")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect((err as ScopeError).statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("readonly + siteverification: deleteSitemap throws ScopeError before any fetch", async () => {
    const fetchMock = mockFetch(200, { access_token: "example-at", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);
    const { auth, dir } = loadAuth([
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/siteverification",
    ]);
    const err = await new GSCClient(auth)
      .deleteSitemap("sc-domain:example.com", "https://example.com/sitemap.xml")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScopeError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("webmasters scope: submitSitemap passes the gate (token refresh, then PUT)", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      url.startsWith("https://oauth2.googleapis.com/")
        ? new Response(JSON.stringify({ access_token: "example-at", expires_in: 3600 }), {
            status: 200,
          })
        : new Response("", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { auth, dir } = loadAuth(["https://www.googleapis.com/auth/webmasters"]);
    await new GSCClient(auth).submitSitemap(
      "sc-domain:example.com",
      "https://example.com/sitemap.xml",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, opts] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(opts.method).toBe("PUT");
    expect(url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml",
    );
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GSCClient.inspectUrl", () => {
  it("targets the v1 URL Inspection endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GSCClient(fakeAuth());
    const res = await client.inspectUrl({
      siteUrl: "sc-domain:example.com",
      inspectionUrl: "https://example.com/page",
    });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("searchconsole.googleapis.com/v1/urlInspection/index:inspect");
    expect(res.inspectionResult!.indexStatusResult!.verdict).toBe("PASS");
  });
});
