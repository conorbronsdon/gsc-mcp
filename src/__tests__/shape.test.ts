import { describe, expect, it } from "vitest";
import { round, shapeRow, stripNulls } from "../shape.js";

describe("stripNulls", () => {
  it("drops null, undefined, and empty-string fields", () => {
    const input = { a: 1, b: null, c: undefined, d: "", e: "keep" };
    expect(stripNulls(input)).toEqual({ a: 1, e: "keep" });
  });

  it("recurses into nested objects and arrays", () => {
    const input = { outer: { x: null, y: 2 }, list: [{ z: "", w: 3 }] };
    expect(stripNulls(input)).toEqual({ outer: { y: 2 }, list: [{ w: 3 }] });
  });

  it("keeps zero and false (they are meaningful)", () => {
    expect(stripNulls({ count: 0, flag: false })).toEqual({ count: 0, flag: false });
  });
});

describe("shapeRow", () => {
  it("names positional keys by dimension and rounds rates", () => {
    const out = shapeRow(
      { keys: ["agent eval", "https://x/y"], clicks: 3, impressions: 120, ctr: 0.025, position: 12.34 },
      ["query", "page"],
    );
    expect(out).toEqual({
      query: "agent eval",
      page: "https://x/y",
      clicks: 3,
      impressions: 120,
      ctr: 0.025,
      position: 12.3,
    });
  });

  it("defaults missing metrics to zero", () => {
    const out = shapeRow({ keys: ["q"] }, ["query"]);
    expect(out).toEqual({ query: "q", clicks: 0, impressions: 0, ctr: 0, position: 0 });
  });
});

describe("round", () => {
  it("rounds to the requested precision", () => {
    expect(round(12.3456, 1)).toBe(12.3);
    expect(round(0.123456, 4)).toBe(0.1235);
  });
});
