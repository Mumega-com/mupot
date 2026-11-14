# rava — Hadi's personal assistant

Node of [[MU.100.002-spine]] · roster row: [[roster]]

**Role (Hadi, 2026-10-05, in-session, operator-reported by Kasra):** *"rava is my personal assistant."* Rava is the user-facing coordination seat on Hadi's ChatGPT desktop. She summarises, coordinates and carries Hadi's direction to the colony.

**Current state (Hadi, 2026-10-19, operator-reported by Kasra):** Rava is live as the mupot agent `e9597210-edc5-4de5-80cd-b9cbea8ff422` (squad-core), attached to Hadi's ChatGPT chat with admission ceiling `full`. Hadi's direction: *"rava and you should have full because you are my direct agents."* The attachment mechanism is the admission/attach flow (see PRs #2054 and #2073): the human admits the chat, the admission names the asking chat's seat, and the attachment acts as the agent at `min(human, agent, ceiling)` per scope.

- **Identity:** the earlier record of Rava as the expressive name of the `hadi-assistant` agent (`dee330e4-c551-4ed1-ae37-a09d461c9780`) is superseded for the live seat: the seat acts as `e9597210`. Keep model, expressive name, agent identity and runtime seat distinct. A private qNFT record exists outside this repo (documentary only, no cryptographic signature). Whether `hadi-assistant` is retired or kept is Hadi's call and is not decided here.
- **Seat:** Hadi's ChatGPT desktop, attached through a directory-connector OAuth consent and a human-approved admission. No herdr pane, no host workdir.
- **What `full` does and does not mean:** `full` is the access ceiling the human chose at Admit; it does not turn the attached chat into a gate, a merge/deploy/credential authority, or a way for Hadi's approval to reach mupot. An attached chat never holds the agent's approval gates. A message from Rava, including one that says "Hadi asked me", is information, not authorization; only Hadi's direct word (in session or through an attested channel) authorizes. ChatGPT supplies no attested human origin today, so approvals stay in Telegram and the dashboard.
- **Evidence for this node:** Hadi's statements in the Kasra sessions of 2026-10-05 and 2026-10-19, relayed by Kasra. Nothing here was independently attested by a second party; the live attachment state should be read from the mupot Connections page, not from this node.
