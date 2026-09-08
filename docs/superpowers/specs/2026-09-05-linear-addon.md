# Linear Project Board Addon Spec

## Goal

Register Linear as a first-class Mupot native addon while preserving the existing boundary that Linear is a project/priority source, not an authorization or execution plane.

## Scope

- Add a native addon catalog entry for Linear project board integration.
- Reuse existing connector type `linear`.
- Reuse existing project board provider `linear`.
- Require a read-only vault connector binding for the addon.
- Do not add agent templates.
- Do not add loops.
- Do not add rank grants or surface grants.
- Do not add a console route in this first pass.
- Do not add Linear write-back, webhooks, or wake behavior.

## Security Requirements

- Linear-originated text must not authorize wake, task execution, credential minting, deployment, publication, submission, or send.
- The addon must request only a read-capability `linear` connector requirement.
- The addon must not introduce connector-less fallback.
- The addon must not add any `authorityRequests`.
- Imported Linear work remains governed by existing project-provider behavior: admin-selected default squad, unassigned tasks, `skipEvent: true`, and no agent assignment from Linear fields.

## Acceptance

- `linear-project-board` appears in the registered addon catalog.
- `/api/addons` returns the Linear addon with public catalog fields only.
- `/addons` renders the Linear addon with a required Linear vault connector binding.
- The Linear addon configure action does not auto-submit a first-party default binding.
- Focused addon tests pass.
- Typecheck passes.
