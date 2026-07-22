-- 0068: persist cross-pot receipt match fields on project_link_receipts.
--
-- Matching receipts already store correlation, envelope/shared hashes, and a
-- relative remote_pot. Verifying a completed cross-pot task without reading raw
-- customer payloads also needs absolute source/destination pot identity, the
-- destination authorization result that admitted the write, and the authorized
-- evidence URL reference (origin-allowlisted at envelope validation time).
--
-- These columns are projection/audit facts alongside the destination-signed
-- receipt payload; they do not change the signed receipt canonical bytes.

ALTER TABLE project_link_receipts ADD COLUMN source_pot TEXT;
ALTER TABLE project_link_receipts ADD COLUMN destination_pot TEXT;
ALTER TABLE project_link_receipts ADD COLUMN authorization_result TEXT;
ALTER TABLE project_link_receipts ADD COLUMN evidence_url TEXT;
