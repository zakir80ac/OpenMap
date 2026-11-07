-- REQ-CMDB-024 REQ-DISC-010 REQ-QA-005 (ADR-042, ADR-043) — collector contract 0.6.0 enum members: the warranty family,
-- the OCI and Alibaba families their collectors already reported, and the service-account and API signing key
-- credential types the GCP, Google Workspace and OCI collectors read.
ALTER TYPE "CollectorFamily" ADD VALUE IF NOT EXISTS 'cloud_oci' AFTER 'cloud_gcp';
ALTER TYPE "CollectorFamily" ADD VALUE IF NOT EXISTS 'cloud_alibaba' AFTER 'cloud_oci';
ALTER TYPE "CollectorFamily" ADD VALUE IF NOT EXISTS 'warranty';
ALTER TYPE "CredentialType" ADD VALUE IF NOT EXISTS 'service_account';
ALTER TYPE "CredentialType" ADD VALUE IF NOT EXISTS 'api_signing_key';
