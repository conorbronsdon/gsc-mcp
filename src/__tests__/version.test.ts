import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { GSCClient } from "../client.js";
import type { GoogleAuth } from "../auth.js";

const pkgVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;

describe("reported version follows package.json", () => {
  it("MCP serverInfo.version equals the package version", async () => {
    const server = createServer(null);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getServerVersion()?.version).toBe(pkgVersion);
    await client.close();
  });

  it("User-Agent carries the package version", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ siteEntry: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const auth = {
      getAccessToken: async () => "AT",
      hasWriteScope: () => true,
      get scopes() {
        return [];
      },
    } as unknown as GoogleAuth;
    await new GSCClient(auth).listSites();
    const [, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["User-Agent"]).toBe(`gsc-mcp/${pkgVersion}`);
    vi.unstubAllGlobals();
  });
});
