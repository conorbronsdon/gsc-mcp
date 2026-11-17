import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

  it("no tool description sends the user to a script that is not shipped", () => {
    const server = serverReturning({});
    const tools = (server as any)._registeredTools as Record<string, any>;
    for (const name of EXPECTED_TOOLS) {
      expect(tools[name].description, name).not.toMatch(/\.py\b/);
    }
  });
});

describe("keyless start", () => {
  it("registers tools with no credential and errors clearly on call", async () => {
    const server = createServer(null); // no client => keyless
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(Object.keys(tools)).toHaveLength(EXPECTED_TOOLS.length);
    const out = await callTool(server, "gsc_list_sites", {});
    expect(out.__error).toMatch(/credential not found/i);
    // The remedy must be actionable for a stranger: no private repo, no script
    // they cannot run. It points at the README and the scope they need.
    expect(out.__error).toMatch(/README/);
    // Guarded generically on purpose: naming the private repos here would put
    // them in a public file, which is the thing being guarded against. A remedy
    // that sends someone to a script or a repo path is the failure mode.
    // The negative control below reuses these exact guard objects, so a guard
    // edited into a form that cannot match (e.g. a literal backspace for \b)
    // turns the control red instead of passing vacuously.
    const scriptGuard = /\.py\b/;
    const repoGuard = /\brepo(sitory)?\b/i;
    expect(out.__error).not.toMatch(scriptGuard);
    expect(out.__error).not.toMatch(repoGuard);
    // Negative control: the guards must be able to go red on the failure mode.
    const badRemedy = "Re-mint it with scripts/setup.py from the private repo.";
    expect(badRemedy).toMatch(scriptGuard);
    expect(badRemedy).toMatch(repoGuard);
  });
});

describe("keyless start with a custom credential path", () => {
  it("names the configured path, not the default, in the setup error", async () => {
    const server = createServer(null, { credentialPath: "/custom/gsc-cred.json" });
    const out = await callTool(server, "gsc_list_sites", {});
    expect(out.__error).toContain("/custom/gsc-cred.json");
    expect(out.__error).not.toContain("searchconsole_credentials.json");
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
  it("names rows by dimension and sends an in-range row limit unchanged", async () => {
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
      row_limit: 1000,
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

describe("gsc_striking_distance schema", () => {
  it("start_date is required and its description does not promise a default", () => {
    const server = serverReturning({});
    const tool = (server as any)._registeredTools["gsc_striking_distance"];
    const shape = tool.inputSchema.shape;
    expect(shape.start_date.isOptional()).toBe(false);
    expect(shape.start_date.description).not.toMatch(/if omitted/i);
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

// --- input hardening (issue #46) ---

/** Connect a real MCP client to the server over an in-memory transport. */
async function connect(server: ReturnType<typeof createServer>): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "example-test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** A server whose fetch mock is returned so tests can assert it was not called. */
function serverWithFetchSpy(body: unknown = { rows: [] }) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { server: createServer(new GSCClient(fakeAuth())), fetchMock };
}

async function listedProps(toolName: string): Promise<Record<string, any>> {
  const client = await connect(createServer(null));
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === toolName)!;
  return tool.inputSchema.properties as Record<string, any>;
}

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

describe("numeric inputs are integers with bounds (tools/list)", () => {
  it("row_limit is an integer in [1, 1000]", async () => {
    const props = await listedProps("gsc_search_analytics");
    expect(props.row_limit).toEqual({
      default: 25,
      description: "Max rows to return (default 25, cap 1000). Keep low; rows cost tokens.",
      type: "integer",
      minimum: 1,
      maximum: 1000,
    });
  });

  it("striking-distance limit is an integer >= 1 and min_impressions an integer >= 0", async () => {
    const props = await listedProps("gsc_striking_distance");
    expect(props.limit.type).toBe("integer");
    expect(props.limit.minimum).toBe(1);
    expect(props.min_impressions.type).toBe("integer");
    expect(props.min_impressions.minimum).toBe(0);
    // Position bounds are averages, so fractional values stay legal.
    expect(props.position_min.type).toBe("number");
    expect(props.position_max.type).toBe("number");
  });
});

describe("numeric inputs reject non-integers before reaching Google", () => {
  it("row_limit 2.5 is rejected and nothing is sent", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    const res = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        site_url: "sc-domain:example.com",
        start_date: "2026-05-01",
        end_date: "2026-05-28",
        row_limit: 2.5,
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain(
      "Invalid input: expected int, received number at row_limit",
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("row_limit 0 and 1001 are rejected; 1 and 1000 are sent as-is", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    const base = {
      site_url: "sc-domain:example.com",
      start_date: "2026-05-01",
      end_date: "2026-05-28",
    };
    for (const bad of [0, 1001]) {
      const res = await client.callTool({
        name: "gsc_search_analytics",
        arguments: { ...base, row_limit: bad },
      });
      expect(res.isError, `row_limit ${bad}`).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
    for (const ok of [1, 1000]) {
      const res = await client.callTool({
        name: "gsc_search_analytics",
        arguments: { ...base, row_limit: ok },
      });
      expect(res.isError, `row_limit ${ok}`).toBeFalsy();
    }
    const sent = fetchMock.mock.calls.map(
      (c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).rowLimit,
    );
    expect(sent).toEqual([1, 1000]);
  });

  it("striking-distance rejects limit 0, limit 1.5 and min_impressions -1 / 2.5", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    const base = {
      site_url: "sc-domain:example.com",
      start_date: "2026-05-01",
      end_date: "2026-05-28",
    };
    // Each case names the constraint that must fire: a bound (.min) or .int().
    const cases: Array<[Record<string, number>, string]> = [
      [{ limit: 0 }, "Too small: expected number to be >=1 at limit"],
      [{ limit: 1.5 }, "Invalid input: expected int, received number at limit"],
      [{ min_impressions: -1 }, "Too small: expected number to be >=0 at min_impressions"],
      [{ min_impressions: 2.5 }, "Invalid input: expected int, received number at min_impressions"],
    ];
    for (const [extra, message] of cases) {
      const res = await client.callTool({
        name: "gsc_striking_distance",
        arguments: { ...base, ...extra },
      });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect((res.content as any)[0].text, JSON.stringify(extra)).toBe(
        `MCP error -32602: Input validation error: Invalid arguments for tool gsc_striking_distance: ${message}`,
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("striking-distance accepts min_impressions 0 and limit 1", async () => {
    const { server } = serverWithFetchSpy({
      rows: [
        { keys: ["a"], clicks: 0, impressions: 0, ctr: 0, position: 10 },
        { keys: ["b"], clicks: 0, impressions: 5, ctr: 0, position: 12 },
      ],
    });
    const client = await connect(server);
    const res = await client.callTool({
      name: "gsc_striking_distance",
      arguments: {
        site_url: "sc-domain:example.com",
        start_date: "2026-05-01",
        end_date: "2026-05-28",
        min_impressions: 0,
        limit: 1,
      },
    });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse((res.content as any)[0].text);
    expect(out.count).toBe(1);
    expect(out.queries[0].query).toBe("b");
  });
});

describe("dates must be YYYY-MM-DD", () => {
  it("both date tools advertise the strict pattern in tools/list", async () => {
    for (const name of ["gsc_search_analytics", "gsc_striking_distance"]) {
      const props = await listedProps(name);
      expect(props.start_date.pattern, `${name}.start_date`).toBe(DATE_PATTERN);
      expect(props.end_date.pattern, `${name}.end_date`).toBe(DATE_PATTERN);
    }
  });

  it("rejects 2026-5-1, 05/01/2026 and 2026-05-01T00:00 without calling Google", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    for (const bad of ["2026-5-1", "05/01/2026", "2026-05-01T00:00"]) {
      for (const name of ["gsc_search_analytics", "gsc_striking_distance"]) {
        const res = await client.callTool({
          name,
          arguments: {
            site_url: "sc-domain:example.com",
            start_date: bad,
            end_date: "2026-05-28",
          },
        });
        expect(res.isError, `${name} ${bad}`).toBe(true);
        expect((res.content as any)[0].text).toContain(
          "Expected a date in YYYY-MM-DD form, e.g. 2026-05-01. at start_date",
        );
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("rejects shape-valid but impossible dates (2026-02-31, 2026-13-01) without calling Google", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    for (const bad of ["2026-02-31", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      for (const name of ["gsc_search_analytics", "gsc_striking_distance"]) {
        const res = await client.callTool({
          name,
          arguments: { site_url: "sc-domain:example.com", start_date: "2026-05-01", end_date: bad },
        });
        expect(res.isError, `${name} ${bad}`).toBe(true);
        expect((res.content as any)[0].text, `${name} ${bad}`).toContain(
          "Expected a real calendar date, e.g. 2026-05-01. at end_date",
        );
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("accepts real calendar edge dates (2028-02-29, 2026-12-31)", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    const res = await client.callTool({
      name: "gsc_search_analytics",
      arguments: { site_url: "sc-domain:example.com", start_date: "2026-12-31", end_date: "2028-02-29" },
    });
    expect(res.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts YYYY-MM-DD and sends it unchanged", async () => {
    const { server, fetchMock } = serverWithFetchSpy();
    const client = await connect(server);
    const res = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        site_url: "sc-domain:example.com",
        start_date: "2026-05-01",
        end_date: "2026-05-28",
      },
    });
    expect(res.isError).toBeFalsy();
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(sent.startDate).toBe("2026-05-01");
    expect(sent.endDate).toBe("2026-05-28");
  });
});

describe("dimension filter fields are described", () => {
  it("groupType, filters, dimension, operator and expression carry descriptions", async () => {
    const props = await listedProps("gsc_search_analytics");
    const group = props.dimension_filter_groups.items;
    const filter = group.properties.filters.items;
    expect(group.properties.groupType.description).toBe(
      "How the filters in this group combine. Only 'and' is supported (the default).",
    );
    expect(group.properties.filters.description).toBe(
      "The filters in this group; all must match (AND).",
    );
    expect(filter.properties.dimension.description).toBe("The dimension this filter tests.");
    expect(filter.properties.operator.description).toBe(
      "How expression is matched against the dimension value. Defaults to 'equals' " +
        "(applied by Google) when omitted.",
    );
    expect(filter.properties.expression.description).toMatch(/^The value to match/);
    // operator stays optional; dimension and expression stay required.
    expect(filter.required).toEqual(["dimension", "expression"]);
  });
});
