// Card E2 — headless tests for the entity detail panel core.
//
// Covers the pure seams (no React, no DOM, no browser — per owner directive;
// the React component EntityPanel.tsx is a thin binding over these):
//
//   1. lib/entity-view.ts — localName (IRI -> display name), isHttpUrl
//      (link-or-text decision), sortProperties (deterministic ordering).
//   2. store/use-entity.ts — EntityLoader: the fetch/abort/stale seam. A
//      superseded load's late response is dropped, an in-flight load is
//      aborted on a newer selection, errors surface, and load(null) idles.
//
// The React hook useEntity is a useSyncExternalStore binding (subscribe + an
// effect that calls load/cancel) and, like the E1 SearchBox hook, is not
// driven here — its observable (EntityLoader) is.
//
// Run: pnpm test (esbuild-bundled, executed via node --test by
// run-contract-tests.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, type FetchOptions } from "../src/api/client";
import type { EntityResponse } from "../src/api/types";
import { isHttpUrl, localName, sortProperties } from "../src/lib/entity-view";
import { EntityLoader } from "../src/store/use-entity";

// ----------------------------------------------------------------- helpers

const entityResponse = (
  iri: string,
  properties: Record<string, string[]> = {}
): EntityResponse => ({
  node: { id: iri, label: `Label for ${iri}`, type: "Dataset", group: "Dataset", purl: null },
  properties,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains the microtask queue so a resolved fetch settles the loader state. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fresh loader with a hand-controlled fake fetch (per-call deferred). */
function makeLoader() {
  const calls: { iri: string; signal?: AbortSignal }[] = [];
  const pending: Deferred<EntityResponse>[] = [];
  const fakeFetch = (iri: string, options?: FetchOptions) => {
    const d = defer<EntityResponse>();
    calls.push({ iri, signal: options?.signal });
    pending.push(d);
    return d.promise;
  };
  return { loader: new EntityLoader(fakeFetch), calls, pending };
}

// ------------------------------------------------------------ 1. name/value

test("localName: path IRI -> last segment", () => {
  assert.equal(localName("https://purls.helmholtz-metadaten.de/hkg/catalog/001"), "001");
  assert.equal(localName("http://d-nb.info/gnd/1081572973"), "1081572973");
});

test("localName: fragment IRI wins over the path", () => {
  assert.equal(localName("https://schema.org/name"), "name");
  assert.equal(localName("http://xmlns.com/foaf/0.1#Person"), "Person");
  assert.equal(localName("http://purl.org/dc/terms/creator#x"), "x");
});

test("localName: a bare value with no / or # is returned unchanged", () => {
  assert.equal(localName("name"), "name");
  assert.equal(localName(""), "");
});

test("isHttpUrl: http/https are linkable, other schemes and literals are not", () => {
  assert.equal(isHttpUrl("https://doi.org/10.1234/abc"), true);
  assert.equal(isHttpUrl("http://example.org/x"), true);
  assert.equal(isHttpUrl("HTTPS://Example.org/UPPER"), true);
  assert.equal(isHttpUrl("urn:isbn:123"), false);
  assert.equal(isHttpUrl("mailto:a@b.c"), false);
  assert.equal(isHttpUrl("_:b0"), false);
  assert.equal(isHttpUrl("plain text value"), false);
  assert.equal(isHttpUrl("https:no-slashes"), false);
});

test("sortProperties: ordered by display name, deterministic tiebreak, values kept", () => {
  const rows = sortProperties({
    "https://schema.org/name": ["A", "B"],
    "http://xmlns.com/foaf/0.1#name": ["C"], // same local name as above
    "http://purl.org/dc/terms/creator": ["https://orcid.org/0000-0001-0000-0001"],
    "https://schema.org/license": ["CC-BY-4.0"],
  });
  assert.deepEqual(
    rows.map((r) => r.name),
    // "creator" < "license" < "name"; the two "name" predicates tiebreak by IRI
    ["creator", "license", "name", "name"]
  );
  // The two "name" rows are ordered by full predicate (foaf before schema.org).
  assert.equal(rows[2].predicate, "http://xmlns.com/foaf/0.1#name");
  assert.equal(rows[3].predicate, "https://schema.org/name");
  // Multi-value lists are preserved on the matching row.
  const schemaName = rows.find((r) => r.predicate === "https://schema.org/name");
  assert.deepEqual(schemaName?.values, ["A", "B"]);
});

test("sortProperties: empty object -> empty row list", () => {
  assert.deepEqual(sortProperties({}), []);
});

// ------------------------------------------------------------ 2. EntityLoader

test("EntityLoader: a successful load reaches ready with the entity", async () => {
  const { loader, pending } = makeLoader();
  loader.load("http://x/A");
  assert.equal(loader.getState().status, "loading");
  assert.equal(loader.getState().iri, "http://x/A");

  pending[0].resolve(entityResponse("http://x/A", { "https://schema.org/name": ["N"] }));
  await flush();

  const s = loader.getState();
  assert.equal(s.status, "ready");
  assert.equal(s.iri, "http://x/A");
  assert.equal(s.error, null);
  assert.equal(s.data?.node.id, "http://x/A");
  assert.deepEqual(s.data?.properties, { "https://schema.org/name": ["N"] });
});

test("EntityLoader: a failed load surfaces an error with a message", async () => {
  const { loader, pending } = makeLoader();
  loader.load("http://x/B");
  pending[0].reject(new ApiError("http", "http://x/B responded 500: boom", 500));
  await flush();

  const s = loader.getState();
  assert.equal(s.status, "error");
  assert.equal(s.iri, "http://x/B");
  assert.equal(s.data, null);
  assert.match(s.error ?? "", /500|boom/);
});

test("EntityLoader: a plain Error (non-ApiError) is described by its message", async () => {
  const { loader, pending } = makeLoader();
  loader.load("http://x/C");
  pending[0].reject(new Error("network down"));
  await flush();
  assert.equal(loader.getState().status, "error");
  assert.equal(loader.getState().error, "network down");
});

test("EntityLoader: a newer selection aborts the in-flight load and wins", async () => {
  const { loader, calls, pending } = makeLoader();
  loader.load("http://x/A"); // in flight
  loader.load("http://x/B"); // supersedes A
  assert.equal(calls[0].signal?.aborted, true, "A's signal must be aborted");

  pending[1].resolve(entityResponse("http://x/B"));
  await flush();
  assert.equal(loader.getState().status, "ready");
  assert.equal(loader.getState().iri, "http://x/B");

  // A's late response must be dropped, not clobber B.
  pending[0].resolve(entityResponse("http://x/A"));
  await flush();
  assert.equal(loader.getState().status, "ready");
  assert.equal(loader.getState().iri, "http://x/B");
  assert.equal(loader.getState().data?.node.id, "http://x/B");
});

test("EntityLoader: a superseded load's error is dropped", async () => {
  const { loader, calls, pending } = makeLoader();
  loader.load("http://x/A");
  loader.load("http://x/B");
  assert.equal(calls[0].signal?.aborted, true);
  // A's fetch fails (it was aborted) — must not surface an error state.
  pending[0].reject(new Error("aborted A"));
  await flush();
  // State reflects the (still loading) B, not A's error.
  assert.equal(loader.getState().iri, "http://x/B");
  assert.equal(loader.getState().status, "loading");
  assert.equal(loader.getState().error, null);
});

test("EntityLoader: load(null) clears the panel to idle", async () => {
  const { loader, pending } = makeLoader();
  loader.load("http://x/A");
  pending[0].resolve(entityResponse("http://x/A"));
  await flush();
  assert.equal(loader.getState().status, "ready");

  loader.load(null);
  await flush();
  const s = loader.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.iri, null);
  assert.equal(s.data, null);
  assert.equal(s.error, null);
});

test("EntityLoader: cancel() aborts the in-flight load", () => {
  const { loader, calls } = makeLoader();
  loader.load("http://x/A");
  assert.equal(calls[0].signal?.aborted, false);
  loader.cancel();
  assert.equal(calls[0].signal?.aborted, true);
});

test("EntityLoader: the fetch receives the IRI and a cancellable signal", () => {
  const { loader, calls } = makeLoader();
  loader.load("http://x/A");
  assert.equal(calls[0].iri, "http://x/A");
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].signal.aborted, false);
});
