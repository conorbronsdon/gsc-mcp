# Security

This server reads a Google OAuth credential from disk (`~/.config/gws/searchconsole_credentials.json` by default) and uses it to call the Google Search Console API. The credential holds a long-lived refresh token — treat it like a password. It is read from the file system, never logged, and never written to stdout. Access tokens are kept in memory only.

Most tools are read-only. Two tools (`gsc_submit_sitemap`, `gsc_delete_sitemap`) change state in Search Console and require the full `webmasters` OAuth scope; they are annotated as write/destructive so MCP clients can gate them.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
