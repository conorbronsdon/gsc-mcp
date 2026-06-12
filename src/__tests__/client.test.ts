import { afterEach, describe, expect, it, vi } from "vitest";
import { GSCClient } from "../client.js";
import {
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ScopeError,
} from "../errors.js";
import type { GoogleAuth } from "../auth.js";

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
