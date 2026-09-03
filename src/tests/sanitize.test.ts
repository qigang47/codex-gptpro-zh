import { describe, expect, it } from "vitest";
import { isLikelyBinary, slugify, truncateText } from "../core/sanitize.js";

describe("sanitize", () => {
  it("slugifies task titles", () => {
    expect(slugify("Build MCP Server!!")).toBe("build-mcp-server");
    expect(slugify("日本語")).toBe("task");
  });

  it("truncates by bytes", () => {
    const result = truncateText("abcdef", 3);
    expect(result).toEqual({ text: "abc", bytes: 3, truncated: true });
  });

  it("detects binary buffers", () => {
    expect(isLikelyBinary(Buffer.from([0, 1, 2, 3]))).toBe(true);
    expect(isLikelyBinary(Buffer.from("hello\n"))).toBe(false);
  });
});
