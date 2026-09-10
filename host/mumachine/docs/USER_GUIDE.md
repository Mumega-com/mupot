# Mupot Connect user guide

Mupot Connect is a macOS developer preview for finding local tools and connecting this app to one of your **existing** Mupot agent identities. Version 0.1.0 does not create an agent, start or stop a model, list Codex desktop tasks, receive inbox messages, control a harness, collect telemetry, update itself or run in the background. See the [master guide](MASTER.md), [feature status](FEATURES.md) and [roadmap](../ROADMAP.md) for the wider product direction.

Current controls are defined in [ui.rs](../src/ui.rs); identity and approval behavior are in [client.rs](../src/client.rs) and [device.rs](../src/device.rs).

## Connect an existing agent today

Have three values ready: the Mupot HTTPS origin, the organization (tenant) ID, and the exact lowercase UUID of the existing agent. A display name is not sufficient because names can be repeated across squads.

1. Open Mupot Connect. The **Network** page discovers known app bundles in the standard macOS application folders and asks Herdr for its runtime list. Discovery is read-only; an installed app or listed runtime is not a verified Mupot identity or a supported desktop-control adapter.
2. Select **Connect an agent** or open **Connect** in the sidebar.
3. Enter **Mupot address**, **Organization ID**, and **Exact Agent ID (UUID)**. The address must be a plain HTTPS origin: no page path, credentials, query, fragment or redirect target.
4. Select **Get approval code**. When the short code appears, select **Open Mupot approval page**. Confirm that the browser is on the same origin you entered, review the code, identity and requested access, then approve or deny there.
5. Leave the app open while it waits at the server-provided interval. A successful response is checked against the requested agent, tenant, bound boot identity and oriented agent before anything is saved.
6. Look for **App identity verified**. The connected view identifies the agent, squad, tenant and channel, and enables the **Boot context** page. The separate local profile contains public connection metadata; the short-lived credential is kept in this app's own macOS Keychain item.

A macOS Keychain prompt may appear during save, load or forget. Refusing it fails that storage action; the app does not fall back to a plaintext token. If saving fails after verification, the connection may remain usable only until this app session or credential expires.

## What each page means

- **Network** shows read-only Herdr runtimes, supported installed desktop apps, and—after verification—accessible registry squadmates. These are three different inventories. Registry membership does not prove that a local runtime is running or able to receive work.
- **Connect** owns the approval flow, saved profiles and the connected-agent actions. **Test connection** checks public server health only; it does not authenticate an agent.
- **Boot context** shows the brief returned only after the expected tenant and agent are verified. Treat it as context, not a grant of extra authority.
- **Activity** keeps a short, session-only list of app events. It does not record approval secrets or credentials and is not a durable audit log.

The sidebar also offers light/dark theme and text-size controls. Demo mode is always labelled and contains invented data; network, discovery, profile reads and Keychain access are disabled.

### Launch options

| Option | Effect | Default |
| --- | --- | --- |
| `--demo` | Uses labeled fixture data and disables the live connections/storage/discovery described above | Off |
| `--page=network`, `--page=connect`, `--page=boot`, `--page=activity` | Selects the initial page; unknown values fall back to Network | Network |
| `--compact` | Starts at 880 × 640 pixels | 1160 × 780 pixels |
| `--light` | Starts in the light theme | Dark theme |

These options select presentation or safe demo behavior; none enables a receiver, changes authorization, or starts another application. The minimum window size is 880 × 640. See [main.rs](../src/main.rs) for the actual parser.

## Connection actions

| Action | Exact effect | What it does not do |
|---|---|---|
| **Refresh boot context** | Revalidates the current credential and bound identity, then reloads boot and roster context. | Does not refresh the credential lifetime or start a runtime. |
| **Check in this app** | Revalidates identity and reports the `mupot-connect` app seat as present. | Does not check in an AI harness, enable inbox receive or prove an agent consumed work. |
| **Load and verify** | Reads only the selected saved app credential and verifies identity again. | Does not auto-connect every saved profile. |
| **Cancel** | Stops the current approval attempt locally and discards late results. | Does not deny or revoke a credential already issued by the server; start a new attempt explicitly. |
| **Switch agent** | Clears the current in-memory connection and pending work, then returns to Connect. | Does not delete profiles, Keychain items or server credentials. |
| **Forget this app's connection…** | Opens a confirmation. Confirming **Forget connection** removes the matching app profile and exact Keychain item and clears the current session. | Does not revoke the server-side credential or alter the Mupot agent. |
| **Forget saved profile** | Immediately removes that listed saved profile and its app Keychain item; this v0.1 control does **not** show a confirmation first. | Does not revoke the server credential. Select carefully; a new browser approval may be required to reconnect. |
| **Server revoke** | Must be performed through an authorized Mupot administrative workflow outside this preview. | Is not available as a Mupot Connect button. |

Use **Forget** when you only want this Mac app to stop retaining its copy. Use server revocation when the credential itself must become invalid everywhere; if both are required, revoke through the owning Mupot surface and then forget the local profile.

## States and common failures

**Not connected** means local discovery can still work but there is no verified app identity. **Waiting for approval** means the browser decision is pending and the code is time-limited. **App identity verified** means boot context is available to this app only. **Runtime receive: not enabled** is the expected v0.1 state.

The app fails closed and explains the next step:

- For an invalid address, remove paths or URL parameters and use the intended HTTPS origin.
- For invalid input, recopy the organization ID and full lowercase agent UUID.
- For identity mismatch, expired approval or refusal, nothing new is saved; verify the intended tenant/agent and begin a new approval.
- For transport failure, check connectivity and the origin, then retry explicitly. A health result still does not verify identity.
- For unsupported or oversized server responses, stop and ask the Mupot operator to check compatibility; do not work around validation.
- For Keychain/profile errors, allow the native prompt and retry. If another Mupot Connect window is updating profiles, let it finish, close this app and reopen it; startup has no profile reload button.
- If a saved credential has expired, reconnect through a new browser approval. Refresh boot context cannot renew it.

## PLANNED: join and operator workflows

These are product intentions, not v0.1 controls, commands or endpoints. They depend on Dara's runtime/desktop adapter contract and Kasra's identity, authority and acceptance gates.

**Join workflow (PLANNED).** A user will map many already-existing desktop agents to the correct Mupot projects and squads while keeping their native apps and runtimes. The flow must show local discovery, exact durable identity, authority, harness compatibility and one chosen inbox owner as separate proofs. Joining wraps existing tools; it does not migrate their runtime or copy harness OAuth secrets.

**Operator workflow (PLANNED).** After joining, the user will work through a favorite agent, Mubot, or the existing Mupot web interface. Herdr CLI developer agents may communicate with desktop operator agents across authorized projects and squads. The Rust local host is intended to expose observed facts such as harness version, model, usage and shared-quota blocks, with controls governed by the user's approved scope. No localhost web server is implied. No desktop task inventory, receiver, harness control or telemetry exists in this preview.

Only one component may own a canonical Mupot inbox or explicitly authorized partition; different seat labels do not create independent ownership of the same inbox. Do not enable another consumer to “test” receive or take credentials from Codex, Claude, Herdr or another harness. Security and acceptance boundaries are maintained in [Security and privacy](SECURITY_AND_PRIVACY.md) and [Testing and acceptance](TESTING_AND_ACCEPTANCE.md).
