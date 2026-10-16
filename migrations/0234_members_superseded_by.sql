-- 0234_members_superseded_by.sql — mupot#1997: a member whose only login identity was moved away by a confirmed
-- linked-sign-in duplicate move (#1022) is SUPERSEDED by the member that took the identity. Nullable, additive: members is
-- created by 0002, so this ALTER is safe on every schema the chain builds. NULL = not superseded (every existing row).
-- Set only inside the move batch (src/auth/link-signin.ts); read by the one shared predicate in
-- src/members/exclusive-control.ts so no email attach ever re-binds a login to a superseded member.
ALTER TABLE members ADD COLUMN superseded_by_member_id TEXT;
