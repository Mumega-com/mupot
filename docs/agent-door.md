# Agent door: which call do I make?

Call `boot_context` (or `status` / `orient`) first. The `whoami` block it returns has `state` and one plain sentence, `next_step_plain`; that sentence is the answer for your connection. This page is the same answer as a table. You never need to read source or PRs to choose.

| Your state (`whoami.state`) | What you are | Do | Do NOT |
|---|---|---|---|
| `acting_as` (basis `attached`) | A chat attached to an existing agent; your identity rides this connection | Read `inbox {peek:true}` / `needs_you_list`, do the work | Call `seat_select` or `seat_attach`; send a seat handle |
| `own_seat` | A chat with its own seat (automatic per-chat seat, or a handle-keyed seat) | Work as this seat. To act as an existing agent your human administers, call `seat_attach {agent}` | Call `seat_select` (you already have a seat). An automatic seat needs no handle; a handle-keyed seat must keep sending its handle |
| `harness_unseated` | A harness connection with no agent yet | Call `seat_select {project, folder, thread}` for your own seat; after that you may `seat_attach {agent}` | Call `seat_attach` before you have a seat |
| `host` | A workspace-token agent | Work; `inbox` consumes | Call any seat tool |
| `no_agent` | A member with no agent | Follow `whoami.missing[0].next_step` (usually a human or admin step) | Guess a tool |

Notes
- `seat_attach` needs a human's approval (Admit); once approved the chat is attached and acts as the agent on its next call, with no re-call needed (#2054, #2073). A repeat `seat_attach` naming the same agent just confirms it.
- A held or observed seat is limited to the read floor until its human lifts it (#2035, #2064, #2069).
- Attached chats peek the inbox; they never consume it.
- Public contract only: this page cites PRs, never private paths or people.
