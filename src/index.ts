#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CREDENTIAL_PATH, GoogleAuth } from "./auth.js";
import { GSCClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  // GSC_CREDENTIALS_PATH lets you point at a non-default credential file.
  const credPath = process.env.GSC_CREDENTIALS_PATH || DEFAULT_CREDENTIAL_PATH;
  const auth = GoogleAuth.tryLoad(credPath);

  // Start keyless: the server must boot and answer tools/list even with no
  // credential, so MCP inspectors (e.g. Glama) can introspect it. Tool *calls*
  // then fail with a clear setup pointer. All diagnostics go to stderr — stdout
  // is the MCP transport and must stay clean JSON-RPC.
  if (!auth) {
    console.error(
      `Warning: no Google Search Console credential at ${credPath}. ` +
        "Tools will error until it is minted.",
    );
    console.error(
      "Mint it once with: python scripts/seo-auth-setup.py (in cot-production). " +
        "It opens a browser for one consent click and is shared with the SEO snapshot script.",
    );
  } else if (!auth.hasWriteScope()) {
    console.error(
      "Note: the credential has only the read-only (webmasters.readonly) scope. " +
        "Read tools work; gsc_submit_sitemap and gsc_delete_sitemap need the full " +
        "webmasters scope — re-run scripts/seo-auth-setup.py to upgrade.",
    );
  }

  const client = auth ? new GSCClient(auth) : null;
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Search Console MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
