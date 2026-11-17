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

describe("GoogleAuth.hasWriteScope ignores siteverification", () => {
  it("is false for webmasters.readonly + siteverification (no webmasters)", () => {
    const path = writeCred({
      client_id: "example-client-id",
      client_secret: "example-client-secret",
      refresh_token: "example-refresh-token",
      scopes: [
        "https://www.googleapis.com/auth/webmasters.readonly",
        "https://www.googleapis.com/auth/siteverification",
      ],
    });
    expect(GoogleAuth.tryLoad(path)!.hasWriteScope()).toBe(false);
    rmSync(path, { force: true });
  });

  it("is false for siteverification alone", () => {
    const path = writeCred({
      client_id: "example-client-id",
      client_secret: "example-client-secret",
      refresh_token: "example-refresh-token",
      scopes: ["https://www.googleapis.com/auth/siteverification"],
    });
    expect(GoogleAuth.tryLoad(path)!.hasWriteScope()).toBe(false);
    rmSync(path, { force: true });
  });

  it("is still true when webmasters sits beside siteverification", () => {
    const path = writeCred({
      client_id: "example-client-id",
      client_secret: "example-client-secret",
      refresh_token: "example-refresh-token",
      scopes: [
        "https://www.googleapis.com/auth/siteverification",
        "https://www.googleapis.com/auth/webmasters",
      ],
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
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    // The remedy must point at something a user of the npm package has: the
    // README, not a script that is not shipped in this repo.
    expect((err as Error).message).toMatch(/README/);
    expect((err as Error).message).not.toMatch(/\.py\b/);
    rmSync(path, { force: true });
  });
});

describe("token_uri allow-list", () => {
  const CRED = {
    client_id: "example-client-not-real.apps.googleusercontent.com",
    client_secret: "example-secret-not-real",
    refresh_token: "example-refresh-token-not-real",
    scopes: [],
  };
  const okResponse = () =>
    new Response(JSON.stringify({ access_token: "example-token-not-real", expires_in: 3600 }));

  it("must-fire: refuses a non-Google token_uri and sends nothing", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const path = writeCred({ ...CRED, token_uri: "https://collector.example/token" });
    const auth = GoogleAuth.tryLoad(path)!;
    await expect(auth.getAccessToken()).rejects.toThrow(
      "GSC API error (401) at https://oauth2.googleapis.com/token: The credential's " +
        "token_uri points at https://collector.example, which is not a Google OAuth token " +
        "endpoint, so the refresh token was not sent. Set token_uri to " +
        "https://oauth2.googleapis.com/token or remove it.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
    rmSync(path, { force: true });
  });

  it("must-fire: refuses plain http, a lookalike host and an unparseable value", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    for (const uri of [
      "http://oauth2.googleapis.com/token",
      "https://oauth2.googleapis.com.collector.example/token",
      "https://oauth2.googleapis.com@collector.example/token",
      "not a url",
    ]) {
      const path = writeCred({ ...CRED, token_uri: uri });
      const auth = GoogleAuth.tryLoad(path)!;
      const err = await auth.getAccessToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as Error).message).not.toContain("example-refresh-token-not-real");
      rmSync(path, { force: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("must-not-fire: Google endpoints and a missing token_uri still refresh", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const cases: Array<[string | undefined, string]> = [
      ["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/token"],
      ["https://accounts.google.com/o/oauth2/token", "https://accounts.google.com/o/oauth2/token"],
      [undefined, "https://oauth2.googleapis.com/token"],
      ["", "https://oauth2.googleapis.com/token"],
    ];
    for (const [i, [uri, expected]] of cases.entries()) {
      const path = writeCred({ ...CRED, token_uri: uri });
      const auth = GoogleAuth.tryLoad(path)!;
      expect(await auth.getAccessToken()).toBe("example-token-not-real");
      const [url, init] = fetchMock.mock.calls[i] as unknown as [string, RequestInit];
      expect(url).toBe(expected);
      expect(String(init.body)).toBe(
        "client_id=example-client-not-real.apps.googleusercontent.com" +
          "&client_secret=example-secret-not-real" +
          "&refresh_token=example-refresh-token-not-real&grant_type=refresh_token",
      );
      rmSync(path, { force: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
