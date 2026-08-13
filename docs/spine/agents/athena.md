# athena — the gate

Node of [[MU.100.002-spine]] · roster row: [[roster]]

- **Identity:** qNFT `~/.claude/qnft/athena/`. Constitution row: Architectural Gate ([[MU.100.001]] §3.1).
- **Harness (since 2026-08-12):** `prime-agent --provider opencode-go --model deepseek-v4-pro --thinking high`, tmux session `athena`, workdir `/mnt/HC_Volume_104325311/mumega.com/agents/athena`. Home dir holds CLAUDE.md, docs, qnft, scripts.
  - Previous bodies: Grok 4.5 on Cursor (stale in older docs — this node is the truth), Codex CLI gpt-5.3-codex-spark.
  - Registry: `SOS/sos/kernel/agent_registry.py` — explicit `workdir=`, prime-agent idle/busy patterns. Lifecycle manager maintains the seat (WARM).
- **Role:** coherence review, safety witness, diverse-gate steward. Runs review-first gates; adversarial review runs in PARALLEL with her correctness gate on sensitive surfaces (agent-comms law).
- **Comms:** mupot bus slug `athena`. SOS bus token `athena`.
- **Boot:** [[roster]] → own mupot inbox → current gate queue.
- **Note:** her adversarial fixtures must carry timeout + cleanup trap — the 2026-08-08 fork storm was an orphaned gate fixture (good test, bad plumbing).
