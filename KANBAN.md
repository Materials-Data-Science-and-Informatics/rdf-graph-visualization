# KANBAN — pointer only

The board of record is the **Hermes Kanban** (durable SQLite board), NOT this file:

- Board slug: `hkg-graph-explorer` ("HKG Graph Explorer", workdir = this repo)
- GUI: desktop app → **Capabilities ▸ Plugins → enable "Kanban"** (ships disabled) →
  sidebar `/kanban` entry → board switcher picks `hkg-graph-explorer`.
- CLI: `hermes kanban --board hkg-graph-explorer list|show|assign|comment|complete ...`
- Workers: `hermes kanban assign <task> <profile>` lets the dispatcher run cards.
- Shared-token LLM budget for ALL workers: stay <=50% of Blablador internal caps
  (alias-large 15/min, alias-code 30/min, alias-fast 50/min, alias-huge 10/min);
  on 429 honor the returned wait — the penalty ladder (60s..3600s) is shared.

## Card ID -> board task ID

| Card | Task |
|---|---|
| F1 | `t_91fa6dd5` |
| F2 | `t_7646959a` |
| F3 | `t_c23adac5` |
| F4 | `t_f6c3b963` |
| F6 | `t_7a7352a0` |
| F7 | `t_1cc7f7a0` |
| B1 | `t_494f80ee` |
| F5 | `t_5b7b2e3b` |
| B2 | `t_94baccdc` |
| B3 | `t_66cfcaaa` |
| B4 | `t_01ed1a80` |
| B5 | `t_7c2222df` |
| C0 | `t_c1df57ee` |
| B6 | `t_b8d12767` |
| B7 | `t_0f0b2db0` |
| C1 | `t_a353230d` |
| C2 | `t_0d38e313` |
| D1 | `t_a101dc36` |
| B8 | `t_60eace7f` |
| C3 | `t_463d011d` |
| C4 | `t_b6253005` |
| D2 | `t_a276c41a` |
| D3 | `t_aa79193c` |
| D4 | `t_ff66ba27` |
| D5 | `t_89b15480` |
| E1 | `t_9bc2bff9` |
| E2 | `t_e754a66d` |
| E4 | `t_4d185fa6` |
| E3 | `t_9b4f8c06` |
| E5 | `t_1f94e893` |
| E6 | `t_613c173c` |

Done: F1 (t_91fa6dd5), F2 (t_7646959a), F3 (t_c23adac5) — pre-board work, commits 06e4e9f / b836159.
Board ends at E5+E6 green = benchmarked RC candidate. Shipping = separate plan later.
