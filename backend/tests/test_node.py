# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""/api/node/{iri}: info-panel summary (fake QLever client, no network)."""

from __future__ import annotations

import threading
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import graph_config, qlever, templates
from app.main import app
from app.qlever import Binding as B
from app.qlever import QleverServerError, SelectResult

CFG = graph_config.load()
REL, REL2, REL3 = CFG.relation_iris()[:3]
LABELS = CFG.label_iris()
GROUP = CFG.groups[0]
SKIP = CFG.skip_iris()[0]
IRI = "https://x.org/n"


class FakeClient:
    """Answers the three node queries from canned rows; records queries."""

    def __init__(self, types=(), labels=(), counts=(), fail=False):
        self.types, self.labels, self.counts, self.fail = types, labels, counts, fail
        self.queries: list[str] = []
        self.threads: set[str] = set()

    def close(self) -> None:
        """Client protocol."""

    def select_tsv(self, query: str) -> SelectResult:
        self.queries.append(query)
        self.threads.add(threading.current_thread().name)
        if self.fail:
            raise QleverServerError("boom")
        if "?n ?p ?l" in query:
            rows = [
                {"n": B("uri", IRI), "p": B("uri", p), "l": B(t, v)}
                for p, t, v in self.labels
            ]
        elif "?n a ?t" in query:
            rows = [{"n": B("uri", IRI), "t": B("uri", t)} for t in self.types]
        else:
            rows = [
                {"p": B("uri", p), "dir": B("literal", d), "n": B("literal", str(n))}
                for p, d, n in self.counts
            ]
        return SelectResult(vars=[], rows=rows)


def get(fake: FakeClient, iri: str = IRI):
    qlever.set_client(fake)
    try:
        with TestClient(app) as client:
            return client.get(f"/api/node/{quote(iri, safe='')}")
    finally:
        qlever.reset_client()


def test_full_summary_sorted_and_filtered() -> None:
    fake = FakeClient(
        types=[GROUP.types[0], "https://x.org/Other"],
        labels=[(LABELS[0], "literal", "Node N")],
        counts=[
            (REL, "out", 2),
            (REL2, "in", 7),
            (REL, "in", 1),  # REL total 3
            (REL3, "in", 0),  # dropped
        ],
    )
    resp = get(fake)
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == IRI and body["label"] == "Node N"
    assert body["group"] == GROUP.name
    assert body["types"] == sorted([GROUP.types[0], "https://x.org/Other"])
    rels = [(r["predicate"], r["out"], r["in"]) for r in body["relations"]]
    assert rels == [(REL2, 0, 7), (REL, 2, 1)]  # total desc, zero row dropped
    assert all(r["out"] + r["in"] > 0 for r in body["relations"])
    assert set(body["relations"][0]) == {"predicate", "out", "in"}
    assert len(fake.queries) == 3  # types, labels, counts - one query each


def test_label_priority_and_group_null_without_mapped_type() -> None:
    fake = FakeClient(
        types=[SKIP],
        labels=[
            (LABELS[1], "literal", "second"),
            (LABELS[0], "uri", "https://x.org/iri-label"),
            (LABELS[0], "literal", "first"),
        ],
    )
    body = get(fake).json()
    assert body["label"] == "first"  # literal beats IRI, config order wins
    assert body["group"] is None  # skip type is not a group
    assert body["types"] == [SKIP]
    assert body["relations"] == []


def test_unknown_iri_is_404() -> None:
    assert get(FakeClient()).status_code == 404


def test_relations_only_node_is_found() -> None:
    body = get(FakeClient(counts=[(REL, "out", 1)])).json()
    assert body["label"] is None and body["group"] is None and body["types"] == []
    assert body["relations"] == [{"predicate": REL, "out": 1, "in": 0}]


def test_invalid_iri_is_422() -> None:
    fake = FakeClient()
    assert get(fake, "not an iri").status_code == 422
    assert get(fake, "noscheme").status_code == 422
    assert not fake.queries


def test_qlever_failure_maps_to_502() -> None:
    assert get(FakeClient(fail=True)).status_code == 502


def test_queries_run_on_the_shared_executor() -> None:
    fake = FakeClient(types=[GROUP.types[0]])
    get(fake)
    assert fake.threads and all(t.startswith("qlever") for t in fake.threads)


def test_counts_query_shape() -> None:
    q = templates.node_relations_query(iri=IRI, relation_iris=[REL, REL2])
    assert f"VALUES ?p {{ <{REL}> <{REL2}> }}" in q
    assert f"VALUES ?s {{ <{IRI}> }}" in q and f"VALUES ?o {{ <{IRI}> }}" in q
    assert "FILTER(isIRI(?o))" in q and "FILTER(isIRI(?s))" in q
    assert '"out" AS ?dir' in q and '"in" AS ?dir' in q and "UNION" in q
    assert "GROUP BY ?p ?dir" in q and "COUNT(*)" in q and "OPTIONAL" not in q


@pytest.mark.parametrize("bad", ["a> } #", "no scheme", ""])
def test_counts_query_rejects_unsafe_input(bad: str) -> None:
    with pytest.raises(ValueError):
        templates.node_relations_query(iri=bad, relation_iris=[REL])
    with pytest.raises(ValueError):
        templates.node_relations_query(iri=IRI, relation_iris=[])


def test_types_only_node_is_found() -> None:
    resp = get(FakeClient(types=[GROUP.types[0]]))
    assert resp.status_code == 200
    body = resp.json()
    assert body["label"] is None and body["relations"] == []
    assert body["group"] == GROUP.name and body["types"] == [GROUP.types[0]]


def test_iri_with_fragment_and_slash_round_trips() -> None:
    iri = "https://x.org/a/b#frag"
    fake = FakeClient(types=[GROUP.types[0]])
    resp = get(fake, iri)
    assert resp.status_code == 200 and resp.json()["id"] == iri
    assert f"<{iri}>" in fake.queries[0]
