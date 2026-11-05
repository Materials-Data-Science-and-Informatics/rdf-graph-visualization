import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNode, HttpError, NdjsonLineSplitter, searchEntities, streamGraph } from "./api";
import type { StreamEvent } from "./api";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

describe("NdjsonLineSplitter", () => {
  it("handles split lines, blanks and a trailing line without newline", () => {
    const s = new NdjsonLineSplitter();
    expect(s.push(enc.encode('{"a":1}\n\n{"b"'))).toEqual(['{"a":1}']);
    expect(s.push(enc.encode(':2}\n{"c":3}'))).toEqual(['{"b":2}']);
    expect(s.flush()).toEqual(['{"c":3}']);
    expect(s.flush()).toEqual([]);
  });
  it("handles CRLF line endings", () => {
    const s = new NdjsonLineSplitter();
    expect(s.push(enc.encode('{"a":1}\r\n{"b":2}\r\n'))).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("handles multibyte characters split across chunks", () => {
    const bytes = enc.encode('{"l":"Jülich €"}\n');
    const s = new NdjsonLineSplitter();
    const out: string[] = [];
    for (const b of bytes) out.push(...s.push(Uint8Array.of(b)));
    expect(out).toEqual(['{"l":"Jülich €"}']);
  });
});

describe("streamGraph", () => {
  it("parses events across chunks incl. ping", async () => {
    const body = enc.encode(
      '{"type":"meta","root":"r","max_nodes":1,"max_hops":1}\n{"type":"ping"}\n{"type":"done","reason":"exhausted"}\n'
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(streamOf([body.slice(0, 10), body.slice(10)])));
    vi.stubGlobal("fetch", fetchMock);
    const events: StreamEvent[] = [];
    await streamGraph({ root: "r", maxNodes: 5, maxHops: 2 }, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["meta", "ping", "done"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/stream?root=r&max_nodes=5&max_hops=2");
  });
  it("parses a final line without newline", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(streamOf([enc.encode('{"type":"done","reason":"exhausted"}')]))
        )
    );
    const events: StreamEvent[] = [];
    await streamGraph({ root: "r" }, (e) => events.push(e));
    expect(events).toEqual([{ type: "done", reason: "exhausted" }]);
  });
  it("cancels the reader on abort", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"type":"ping"}\n'));
      },
      cancel,
    });
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await streamGraph({ root: "x" }, () => ctrl.abort(), ctrl.signal).catch(() => undefined);
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects with status on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response('{"detail":"bad iri"}', { status: 422, statusText: "Unprocessable" })
        )
    );
    const err = await streamGraph({ root: "x" }, () => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toContain("bad iri");
  });
  it("rejects when aborted mid-stream", async () => {
    const ctrl = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"type":"ping"}\n'));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    const err = await streamGraph({ root: "x" }, () => ctrl.abort(), ctrl.signal).catch(
      (e: unknown) => e
    );
    expect(ctrl.signal.aborted).toBe(true);
    expect(err).toBeDefined();
  });
});

describe("fetchNode / searchEntities", () => {
  it("maps 404 to null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(fetchNode("https://x/y")).resolves.toBeNull();
  });
  it("returns search results", async () => {
    const results = [{ id: "a", label: "A", type: "Person" }];
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ query: "a b", results })));
    vi.stubGlobal("fetch", f);
    await expect(searchEntities("a b")).resolves.toEqual(results);
    expect(f.mock.calls[0][0]).toBe("/api/search?q=a%20b");
  });
});
