#!/bin/bash
# Helmholtz KG — Fetch representative subgraph, then all types for collected IDs
# Output: helmholtz_kg_subgraph.ttl

set -e
ENDPOINT="https://virtuoso.unhide.helmholtz-metadaten.de/sparql/"
GRAPH="http://purls.helmholtz-metadaten.de/helmholtzkg"
OUT="helmholtz_kg_subgraph.ttl"
BATCH=100
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== Phase 1: Fetch entities & edges ==="

fetch() {
  local label="$1"; shift
  local query="$1"; shift
  echo "  $label..."
  curl -s "$ENDPOINT" \
    --data-urlencode "default-graph-uri=$GRAPH" \
    --data-urlencode "query=$query" \
    -H "Accept: text/turtle" > "$TMPDIR/current.ttl"
  cat "$TMPDIR/current.ttl" >> "$TMPDIR/all_entities.ttl"
}

P="PREFIX schema: <https://schema.org/>"

fetch "Datasets" "$P CONSTRUCT { ?s a schema:Dataset ; schema:name ?n } WHERE { ?s a schema:Dataset ; schema:name ?n } LIMIT 350"
fetch "Persons" "$P CONSTRUCT { ?s a schema:Person ; schema:name ?n } WHERE { ?s a schema:Person ; schema:name ?n } LIMIT 350"
fetch "Organizations" "$P CONSTRUCT { ?s a schema:Organization ; schema:name ?n } WHERE { ?s a schema:Organization ; schema:name ?n } LIMIT 200"
fetch "DataCatalogs" "$P CONSTRUCT { ?s a schema:DataCatalog ; schema:name ?n } WHERE { ?s a schema:DataCatalog ; schema:name ?n } LIMIT 40"
fetch "ScholarlyArticles" "$P CONSTRUCT { ?s a schema:ScholarlyArticle ; schema:name ?n } WHERE { ?s a schema:ScholarlyArticle ; schema:name ?n } LIMIT 150"
fetch "Reports" "$P CONSTRUCT { ?s a schema:Report ; schema:name ?n } WHERE { ?s a schema:Report ; schema:name ?n } LIMIT 40"
fetch "SoftwareSourceCode" "$P CONSTRUCT { ?s a schema:SoftwareSourceCode ; schema:name ?n } WHERE { ?s a schema:SoftwareSourceCode ; schema:name ?n } LIMIT 40"
fetch "Events" "$P CONSTRUCT { ?s a schema:Event ; schema:name ?n } WHERE { ?s a schema:Event ; schema:name ?n } LIMIT 40"
fetch "Dataset→author" "$P CONSTRUCT { ?ds schema:author ?per } WHERE { ?ds a schema:Dataset ; schema:author ?per } LIMIT 400"
fetch "Dataset→creator" "$P CONSTRUCT { ?ds schema:creator ?org } WHERE { ?ds a schema:Dataset ; schema:creator ?org } LIMIT 400"
fetch "Dataset→catalog" "$P CONSTRUCT { ?ds schema:includedInDataCatalog ?cat } WHERE { ?ds a schema:Dataset ; schema:includedInDataCatalog ?cat } LIMIT 200"
fetch "Article→author" "$P CONSTRUCT { ?a schema:author ?p } WHERE { ?a a schema:ScholarlyArticle ; schema:author ?p } LIMIT 400"
fetch "Person→affiliation" "$P CONSTRUCT { ?per schema:affiliation ?org } WHERE { ?per a schema:Person ; schema:affiliation ?org } LIMIT 400"
fetch "Org→subOrganization" "$P CONSTRUCT { ?org schema:subOrganization ?sub } WHERE { ?org a schema:Organization ; schema:subOrganization ?sub } LIMIT 100"

echo ""
echo "=== Phase 2: Extract all unique IDs ==="

cat "$TMPDIR/all_entities.ttl" | grep -oE '<http[^>]+>' | sort -u > "$TMPDIR/all_ids.txt"
N=$(wc -l < "$TMPDIR/all_ids.txt")
echo "  $N unique entity IDs found"

echo ""
echo "=== Phase 3: Fetch ALL types for all IDs in batches of $BATCH ==="

> "$TMPDIR/all_types.ttl"
processed=0

while IFS= read -r id; do
  batch_ids="$id"
  for i in $(seq 2 $BATCH); do
    if IFS= read -r nid; then
      batch_ids="${batch_ids}"$'\n'"$nid"
    else
      break
    fi
  done

  values="VALUES ?s { $(echo "$batch_ids" | tr '\n' ' ' | sed 's/ $//') }"

  curl -s "$ENDPOINT" \
    --data-urlencode "default-graph-uri=$GRAPH" \
    --data-urlencode "query=CONSTRUCT { ?s a ?t } WHERE { $values ?s a ?t }" \
    -H "Accept: text/turtle" >> "$TMPDIR/all_types.ttl" 2>/dev/null

  processed=$((processed + BATCH))
  if [ $((processed % 1000)) -le $BATCH ]; then
    echo "  $processed / $N..."
  fi
done < "$TMPDIR/all_ids.txt"

echo "  Done fetching types"
echo ""
echo "=== Phase 4: Assemble output ==="

{
  echo '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .'
  echo '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .'
  echo '@prefix schema: <https://schema.org/> .'
  echo ''
  echo '# Helmholtz KG subgraph — entities + edges + all types'
  cat "$TMPDIR/all_entities.ttl"
  echo ''
  echo '# All types for collected entities'
  cat "$TMPDIR/all_types.ttl"
} > "$OUT"

echo ""
echo "=== Done ==="
echo "Output: $OUT"
wc -l "$OUT"
du -sh "$OUT"