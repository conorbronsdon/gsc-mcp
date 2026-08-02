import { describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import { GSCClient } from "../client.js";
import type { GoogleAuth } from "../auth.js";

function fakeAuth(hasWrite = true): GoogleAuth {
  return {
    getAccessToken: async () => "AT",
    hasWriteScope: () => hasWrite,
    get scopes() {
      return [];
    },
  } as unknown as GoogleAuth;
}

/** Build a server whose client is backed by a stubbed global fetch. */
function serverReturning(body: unknown, status = 200, hasWrite = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
        }),
    ),
  );
  return createServer(new GSCClient(fakeAuth(hasWrite)));
}

/** Invoke a registered tool's handler with zod defaults applied, parse its JSON. */
async function callTool(
  server: ReturnType<typeof createServer>,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = await tool.handler(parsed, {} as any);
  const text = result.content[0].text;
  if (result.isError) return { __error: text };
  return JSON.parse(text);
}

const EXPECTED_TOOLS = [
  "gsc_list_sites",
  "gsc_search_analytics",
  "gsc_striking_distance",
  "gsc_list_sitemaps",
  "gsc_submit_sitemap",
  "gsc_delete_sitemap",
  "gsc_inspect_url",
];

describe("tool registry + annotations", () => {
  it("registers exactly the documented tool set", () => {
    const server = serverReturning({});
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(Object.keys(tools).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("every tool has complete annotations (title + all five hints)", () => {
    const server = serverReturning({});
    const tools = (server as any)._registeredTools as Record<string, any>;
    for (const name of EXPECTED_TOOLS) {
      const a = tools[name].annotations;
      expect(a, `${name} annotations`).toBeDefined();
      expect(typeof a.title, `${name}.title`).toBe("string");
      expect(typeof a.readOnlyHint, `${name}.readOnlyHint`).toBe("boolean");
      expect(typeof a.destructiveHint, `${name}.destructiveHint`).toBe("boolean");
      expect(typeof a.idempotentHint, `${name}.idempotentHint`).toBe("boolean");
      expect(typeof a.openWorldHint, `${name}.openWorldHint`).toBe("boolean");
    }
  });

  it("read tools are readOnly + non-destructive; writes flip the right hints", () => {
    const server = serverReturning({});
    const tools = (server as any)._registeredTools as Record<string, any>;
    const reads = [
      "gsc_list_sites",
      "gsc_search_analytics",
      "gsc_striking_distance",
      "gsc_list_sitemaps",
      "gsc_inspect_url",
    ];
    for (const name of reads) {
      expect(tools[name].annotations.readOnlyHint, name).toBe(true);
      expect(tools[name].annotations.destructiveHint, name).toBe(false);
    }
    // submit: write but not destructive
    expect(tools["gsc_submit_sitemap"].annotations.readOnlyHint).toBe(false);
    expect(tools["gsc_submit_sitemap"].annotations.destructiveHint).toBe(false);
    // delete: write and destructive
    expect(tools["gsc_delete_sitemap"].annotations.readOnlyHint).toBe(false);
    expect(tools["gsc_delete_sitemap"].annotations.destructiveHint).toBe(true);
  });
});

describe("keyless start", () => {
  it("registers tools with no credential and errors clearly on call", async () => {
    const server = createServer(null); // no client => keyless
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(Object.keys(tools)).toHaveLength(EXPECTED_TOOLS.length);
    const out = await callTool(server, "gsc_list_sites", {});
    expect(out.__error).toMatch(/credential not found/i);
    expect(out.__error).toMatch(/credential not found/i);
    // The remedy must be actionable for a stranger: no private repo, no script
    // they cannot run. It points at the README and the scope they need.
    expect(out.__error).toMatch(/README/);
    expect(out.__error).not.toMatch(/cot-production|personal-context/);
  });
});

describe("gsc_list_sites tool", () => {
  it("returns properties with permission levels", async () => {
    const server = serverReturning({
      siteEntry: [
        { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        { siteUrl: "https://blog.example.com/", permissionLevel: "siteFullUser" },
      ],
    });
    const out = await callTool(server, "gsc_list_sites", {});
    expect(out.propertyCount).toBe(2);
    expect(out.properties[0].siteUrl).toBe("sc-domain:example.com");
  });
});

describe("gsc_search_analytics tool", () => {
  it("names rows by dimension and caps the row limit at 1000", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, opts: RequestInit) => {
        calls.push(opts);
        return new Response(
          JSON.stringify({
            rows: [
              { keys: ["agent eval"], clicks: 5, impressions: 200, ctr: 0.025, position: 9.2 },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const server = createServer(new GSCClient(fakeAuth()));
    const out = await callTool(server, "gsc_search_analytics", {
      site_url: "sc-domain:example.com",
      start_date: "2026-05-01",
      end_date: "2026-05-28",
      row_limit: 99999,
    });
    const sent = JSON.parse(String(calls[0].body));
    expect(sent.rowLimit).toBe(1000);
    expect(out.rows[0].query).toBe("agent eval");
    expect(out.rows[0].position).toBe(9.2);
  });
});

describe("gsc_striking_distance tool", () => {
  it("keeps only queries in the position band above the impression floor", async () => {
    const server = serverReturning({
      rows: [
        { keys: ["winning kw"], clicks: 50, impressions: 900, ctr: 0.055, position: 2.1 }, // page 1, excluded
        { keys: ["striking kw"], clicks: 1, impressions: 300, ctr: 0.003, position: 11.4 }, // in band
        { keys: ["low impr kw"], clicks: 0, impressions: 3, ctr: 0, position: 14.0 }, // below floor
        { keys: ["too deep kw"], clicks: 0, impressions: 80, ctr: 0, position: 40.0 }, // out of band
      ],
    });
    const out = await callTool(server, "gsc_striking_distance", {
      site_url: "sc-domain:example.com",
      start_date: "2026-05-01",
      end_date: "2026-05-28",
    });
    expect(out.count).toBe(1);
    expect(out.queries[0].query).toBe("striking kw");
  });
});

describe("gsc_list_sitemaps tool", () => {
  it("projects the key sitemap status fields", async () => {
    const server = serverReturning({
      sitemap: [
        {
          path: "https://example.com/sitemap.xml",
          isPending: false,
          lastDownloaded: "2026-06-08T00:00:00Z",
          warnings: "0",
          errors: "0",
        },
      ],
    });
    const out = await callTool(server, "gsc_list_sitemaps", {
      site_url: "sc-domain:example.com",
    });
    expect(out.sitemapCount).toBe(1);
    expect(out.sitemaps[0].path).toBe("https://example.com/sitemap.xml");
  });
});

describe("gsc_submit_sitemap tool", () => {
  it("submits and reports the pinged status", async () => {
    const server = serverReturning("", 200, true);
    const out = await callTool(server, "gsc_submit_sitemap", {
      site_url: "sc-domain:example.com",
      feedpath: "https://example.com/sitemap.xml",
    });
    expect(out.status).toBe("submitted");
  });

  it("errors clearly when the credential lacks the write scope", async () => {
    const server = serverReturning("", 200, false);
    const out = await callTool(server, "gsc_submit_sitemap", {
      site_url: "sc-domain:example.com",
      feedpath: "https://example.com/sitemap.xml",
    });
    expect(out.__error).toMatch(/webmasters scope/i);
  });
});

describe("gsc_inspect_url tool", () => {
  it("projects a compact index-status summary", async () => {
    const server = serverReturning({
      inspectionResult: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          lastCrawlTime: "2026-06-07T12:00:00Z",
          googleCanonical: "https://example.com/page",
        },
        mobileUsabilityResult: { verdict: "PASS" },
        inspectionResultLink: "https://search.google.com/...",
      },
    });
    const out = await callTool(server, "gsc_inspect_url", {
      site_url: "sc-domain:example.com",
      inspection_url: "https://example.com/page",
    });
    expect(out.index.verdict).toBe("PASS");
    expect(out.index.coverageState).toBe("Submitted and indexed");
    expect(out.mobileUsability).toBe("PASS");
  });
});
