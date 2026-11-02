# KANBAN — pointer only

The board of record is the **Hermes Kanban** (durable SQLite board), NOT this file:

- Board slug: `hkg-graph-explorer` ("HKG Graph Explorer", workdir = this repo)
- GUI: desktop app → **Capabilities ▸ Plugins → enable "Kanban"** (ships disabled) →
  sidebar `/kanban` entry → board switcher picks `hkg-graph-explorer`.
- CLI: `hermes kanban --board hkg-graph-explorer list|show|assign|comment|complete ...`
- Wiring: every task workspace = `dir @ /home/ubuntu/fzj/rdf-graph-visualization`, workers pinned
  `alias-code`; infra cards -> `default` profile, code cards -> `fzj-sec`. Dispatcher (gateway) claims
  ready cards automatically; pushing/merging stays with the owner.
- Shared-token LLM budget for ALL workers: stay <=50% of Blablador internal caps
  (alias-large 15/min, alias-code 30/min, alias-fast 50/min, alias-huge 10/min);
  on 429 honor the returned wait — the penalty ladder (60s..3600s) is shared.

Sizing rule (added 2026-11-02 after hour-long runs were observed): one card = one worker
session = 45-90 min of agent time max. Human-day estimates must be staged (commit per step,
hard stop at cap, worker files a follow-up child card via kanban_create). New oversized
cards enter via `create --triage` + `hermes kanban decompose <id>`.

## Card ID -> board task ID

| Card | Task |
|---|---|
| F1 | `t_91fa6dd5` |
| F2 | `t_7646959a` |
| F3 | `t_c23adac5` |
| F4 | `t_e2381dce` |
| F6 | `t_718befcd` |
| F7 | `t_38bccff1` |
| B1 | `t_0f02ead4` |
| F5 | `t_c9177d84` |
| B2 | `t_c3307a07` |
| B3 | `t_c8d753ad` |
| B4 | `t_3effc7cb` |
| B5 | `t_729821b6` |
| C0 | `t_85eb5a6a` |
| B6 | `t_8ddbc3c9` |
| B7 | `t_de5aaf90` |
| C1 | `t_eb2ec10a` |
| C2 | `t_b5b991e4` |
| D1 | `t_a88902fe` |
| B8 | `t_ca86c192` |
| C3 | `t_4a5a0471` |
| C4 | `t_b51be15f` |
| D2 | `t_d16966f9` |
| D3 | `t_784ac418` |
| D4 | `t_4a31db82` |
| D5 | `t_37a1c197` |
| E1 | `t_42d9ba45` |
| E2 | `t_a26dba25` |
| E4 | `t_0fb4940f` |
| E3 | `t_30e595df` |
| E5 | `t_223f6f25` |
| E6 | `t_a801643f` |

Done: F1 (t_91fa6dd5), F2 (t_7646959a), F3 (t_c23adac5) — pre-board work, commits 06e4e9f / b836159.
Board ends at E5+E6 green = benchmarked RC candidate. Shipping = separate plan later.
