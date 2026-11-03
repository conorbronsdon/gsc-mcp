import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import * as lib from "../lib.js";

const GSC_TOOLS = [
  "gsc_list_sites",
  "gsc_search_analytics",
  "gsc_striking_distance",
  "gsc_list_sitemaps",
  "gsc_submit_sitemap",
  "gsc_delete_sitemap",
  "gsc_inspect_url",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registered = (s: McpServer) => (s as any)._registeredTools as Record<string, any>;

describe("library entry", () => {
  it("exports the embedding surface", () => {
    expect(typeof lib.registerGscTools).toBe("function");
    expect(typeof lib.createServer).toBe("function");
    expect(typeof lib.GSCClient).toBe("function");
    expect(typeof lib.GoogleAuth.tryLoad).toBe("function");
    expect(lib.DEFAULT_CREDENTIAL_PATH).toMatch(/searchconsole_credentials\.json$/);
  });

  it("mounts the same seven tools on a host server next to its own tools", () => {
    const host = new McpServer({ name: "host", version: "0.0.0" });
    host.registerTool("host_tool", { description: "x", inputSchema: {} }, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    lib.registerGscTools(host, null);
    expect(Object.keys(registered(host)).sort()).toEqual(["host_tool", ...GSC_TOOLS].sort());
  });

  it("registers identical schemas and annotations to the standalone server", () => {
    const host = new McpServer({ name: "host", version: "0.0.0" });
    lib.registerGscTools(host, null);
    const standalone = registered(lib.createServer(null));
    for (const name of GSC_TOOLS) {
      expect(registered(host)[name].annotations).toEqual(standalone[name].annotations);
      expect(registered(host)[name].description).toEqual(standalone[name].description);
    }
  });

  it("names the configured credential path in the keyless setup error", async () => {
    const host = new McpServer({ name: "host", version: "0.0.0" });
    lib.registerGscTools(host, null, { credentialPath: "/custom/gsc.json" });
    const res = await registered(host).gsc_list_sites.handler({}, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("/custom/gsc.json");
  });
});
