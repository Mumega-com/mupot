# Agent door: which call do I make?

Call `boot_context` (or `status` / `orient`) first. The `whoami` block it returns has `state` and one plain sentence, `next_step_plain`; that sentence is the answer for your connection. This page is the same answer as a table. You never need to read source or PRs to choose.

| Your state (`whoami.state`) | What you are | Do | Do NOT |
|---|---|---|---|
| `acting_as` (basis `attached`) | A chat attached to an existing agent; your identity rides this connection | Read `inbox {peek:true}` / `needs_you_list`, do the work | Call `seat_select` or `seat_attach`. An OAuth/automatic seat needs no handle; a handle-keyed seat keeps passing its handle |
| `own_seat` | A chat with its own seat (automatic per-chat seat, or a handle-keyed seat) | Work as this seat. To act as an existing agent, call `seat_attach {agent, reason: "why this chat should act as that agent"}` (pending; human admits the code on /connections; `seat_attach` again returns attached). When this pot requires attach designation, the human presses 'Allow for me' on the agent page first; `seat_attach` before that returns 409 `agent_not_designated_for_you`. Not from a held or observed seat | Call `seat_select` (you already have a seat). An automatic seat needs no handle; a handle-keyed seat must keep sending its handle |
| `harness_unseated` | A harness connection with no agent yet | Call `boot_context`, then `seat_select {project, folder, thread}` and pass the `mseat_` handle as `seat` on every later call. Then the own_seat attach order | Call `seat_attach` before you have a seat |
| `host` | A workspace-token agent | Work; `inbox` consumes | Call any seat tool |
| `no_agent` | A member with no agent | Follow `whoami.missing[0].next_step` (usually a human or admin step) | Guess a tool |

Notes
- `seat_attach` needs a human's approval (Admit); once approved the chat is attached and acts as the agent on its next call, with no re-call needed (#2054, #2073). A repeat `seat_attach` naming the same agent just confirms it.
- A held or observed seat is limited to the read floor until its human lifts it (#2035, #2064, #2069).
- Attached chats peek the inbox (`inbox {peek:true}`, `inbox_mark_handled`); they never ack or lease it.
- Grok Bot (and any handle-keyed chat) reads this order from `whoami.next_step_plain` on an unattached seat, before the first `seat_attach`. Same order: [Grok Bot plugin](plugins/mupot-grokbot-plugin.md).
- Public contract only: this page cites PRs, never private paths or people.
