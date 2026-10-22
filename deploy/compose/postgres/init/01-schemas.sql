-- REQ-INT-001 — schemas for the platform services that share the Postgres instance.
-- OpenMap's own tables live in public (Prisma); Keycloak and Superset get their own schemas.
CREATE SCHEMA IF NOT EXISTS keycloak;
CREATE SCHEMA IF NOT EXISTS superset;
