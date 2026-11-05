// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConfig } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("fetchConfig", () => {
  it("reports HTTP errors cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x", { status: 502, statusText: "Bad Gateway" }))
    );
    await expect(fetchConfig()).rejects.toThrow("Backend returned 502 Bad Gateway");
  });
  it("reports non-JSON bodies cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(fetchConfig()).rejects.toThrow("non-JSON");
  });
  it("returns parsed config", async () => {
    const body = { graph: { groups: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    await expect(fetchConfig()).resolves.toEqual(body);
  });
});
