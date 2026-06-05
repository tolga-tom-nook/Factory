<!-- GENERATED FILE. Do not edit directly. Run npm run docs:diagrams. -->

---
status: generated
owner: platform
doc_type: diagram
fidelity: generated
title: "Factory Documentation Trust Map"
generator: npm run docs:diagrams
last_generated: 2026-06-04
source:
  - docs/_catalog/docs-graph.json
  - docs/_governance/canonical-docs.yml
---

# Factory Documentation Trust Map

This diagram is generated from the docs graph. It intentionally omits the graph hash to avoid self-referential churn because the graph includes generated diagram content hashes.

```mermaid
flowchart LR
  truth["Truth Sources"] --> canonical["Canonical Docs"]
  canonical --> active["Active Docs"]
  active --> stale["Stale Docs"]
  stale --> archive["Archive Docs"]
  canonical["Canonical Docs\n17"]
  active["Active Docs\n377"]
  stale["Stale Docs\n0"]
  archive["Archive Docs\n45"]
  generated["Generated Docs\n3"]
  truth --> generated
  generated --> canonical
```
