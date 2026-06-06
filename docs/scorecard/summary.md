# Launch Readiness Scorecard

*Generated: 2026-06-06T09:35:08.191824+00:00 · Reporting day: 2026-06-06*

## Org composite

**67.0 / 100** — Latimer-Woods-Tech (portfolio)

| Dimension | Weight | Score | Detail |
|---|--:|--:|---|
| conformance | 40% | 51 | avg cohesion across 5 apps |
| cost | 20% | 98 | worst-cap utilisation 3% |
| mrr | 20% | — | MRR is 0 — Stage 2 not yet generating recurring |
| reliability | 20% | — | awaiting Sentry user-facing error rate (#723) |

## Per-app scorecard

| Repo | Composite | Conformance | Completion | Reliability |
|---|--:|--:|--:|--:|
| **factory-admin-studio** (FA) | **41.3** | 62 | 0 | — |
| **HumanDesign** (HD) | **35.3** | 53 | 0 | — |
| **xico-city** (XC) | **34.0** | 51 | 0 | — |
| **cypher-healing** (CH) | **32.7** | 49 | 0 | — |
| **capricast** (CC) | **28.0** | 42 | 0 | — |

## Notes on dimensions reporting `—`

- **Reliability** awaits per-app Sentry user.id emission (issue #723 — `@lwt/monitoring` adoption).
- **MRR** is excluded from the org score until Stripe MRR > 0 (Stage 2 acquisition target).
  Dimensions with no data are excluded from the weighted average rather than scored as 0,
  so the score reflects what we can measure today, not penalise what we haven't wired yet.

## Targets

- **Stage 2 exit:** org composite ≥ 60, every dimension scoring (no `—`)
- **Stage 4 exit:** every per-app composite ≥ 70 (matches conformance shadow threshold)
- **Stage 5 exit:** every per-app composite ≥ 80 + privacy/a11y conformance ≥ 80
