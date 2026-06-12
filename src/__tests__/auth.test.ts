import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoogleAuth } from "../auth.js";
import { AuthError } from "../errors.js";

function writeCred(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "gsc-"));
  const path = join(dir, "cred.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GoogleAuth.tryLoad", () => {
  it("returns null when the file is missing (keyless start)", () => {
    expect(GoogleAuth.tryLoad("/no/such/file.json")).toBeNull();
  });

  it("returns null when refresh_token / client fields are absent", () => {
    const path = writeCred({ token: "x" });
    expect(GoogleAuth.tryLoad(path)).toBeNull();
    rmSync(path, { force: true });
  });

  it("loads a google-auth to_json() shaped credential", () => {
    const path = writeCred({
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "rt",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    const auth = GoogleAuth.tryLoad(path);
    expect(auth).not.toBeNull();
    expect(auth!.scopes).toContain(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
    rmSync(path, { force: true });
  });
});

describe("GoogleAuth.hasWriteScope", () => {
  it("is false for a readonly-only credential", () => {
    const path = writeCred({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
    });
    expect(GoogleAuth.tryLoad(path)!.hasWriteScope()).toBe(false);
    rmSync(path, { force: true });
  });

  it("is true once the full webmasters scope is present", () => {
    const path = writeCred({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      scopes: ["https://www.googleapis.com/auth/webmasters"],
    });
    expect(GoogleAuth.tryLoad(path)!.hasWriteScope()).toBe(true);
    rmSync(path, { force: true });
  });
});

describe("GoogleAuth.getAccessToken", () => {
  it("refreshes against the token endpoint and caches the result", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "AT", expires_in: 3600 }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const path = writeCred({
      client_id: "c",
      client_secret: "s",
      refresh_token: "r",
      scopes: [],
    });
    const auth = GoogleAuth.tryLoad(path)!;
    const t1 = await auth.getAccessToken();
    const t2 = await auth.getAccessToken();
    expect(t1).toBe("AT");
    expect(t2).toBe("AT");
    // Cached: only one network call despite two getAccessToken calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Posts to Google's token endpoint with the refresh grant.
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("oauth2.googleapis.com/token");
    expect(String(opts.body)).toContain("grant_type=refresh_token");
    rmSync(path, { force: true });
  });

  it("throws AuthError when the refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const path = writeCred({
      client_id: "c",
      client_secret: "s",
      refresh_token: "revoked",
      scopes: [],
    });
    const auth = GoogleAuth.tryLoad(path)!;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthError);
    rmSync(path, { force: true });
  });
});
