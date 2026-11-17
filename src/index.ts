#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_CREDENTIAL_PATH, GoogleAuth } from "./auth.js";
import { GSCClient } from "./client.js";
import { CredentialMissingError } from "./errors.js";
import { createServer } from "./server.js";

async function main() {
  // GSC_CREDENTIALS_PATH lets you point at a non-default credential file.
  const credPath = process.env.GSC_CREDENTIALS_PATH || DEFAULT_CREDENTIAL_PATH;
  // One read at startup decides both the warning and the per-tool error; a
  // credential fixed later takes effect when the server is restarted.
  const loaded = GoogleAuth.load(credPath);
  const auth = "auth" in loaded ? loaded.auth : null;
  const credentialProblem = "problem" in loaded ? loaded.problem : undefined;

  // Start keyless: the server must boot and answer tools/list even with no
  // credential, so MCP inspectors (e.g. Glama) can introspect it. Tool *calls*
  // then fail with a clear setup pointer. All diagnostics go to stderr — stdout
  // is the MCP transport and must stay clean JSON-RPC.
  if (!auth) {
    console.error(
      `Warning: ${new CredentialMissingError(credPath, credentialProblem).message} ` +
        "Tools will error until it is fixed.",
    );
  } else if (!auth.hasWriteScope()) {
    console.error(
      "Note: the credential has only the read-only (webmasters.readonly) scope. " +
        "Read tools work; gsc_submit_sitemap and gsc_delete_sitemap need the full " +
        "webmasters scope — re-run the OAuth flow from the README with that scope to upgrade.",
    );
  }

  const client = auth ? new GSCClient(auth) : null;
  // Pass the resolved path so the per-tool setup error names the file this
  // process actually looked for (GSC_CREDENTIALS_PATH or the default).
  const server = createServer(client, { credentialPath: credPath, credentialProblem });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Google Search Console MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
