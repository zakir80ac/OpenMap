-- REQ-SEC-011 (ADR-067 step 4) — a custom field whose values are personal data: stored as OpenBao Transit ciphertext
-- in cis."customFields", decrypted by the API on the way out, never filtered. Existing fields stay plain.
ALTER TABLE "custom_field_definitions" ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false;
