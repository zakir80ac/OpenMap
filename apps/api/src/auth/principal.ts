// REQ-CORE-012 — the verified caller: Keycloak subject, tenant claim and realm roles.
export interface Principal {
  subject: string;
  username: string;
  /** Tenant id from the `tenant` claim; every repository call is scoped by it. */
  tenantId: string;
  roles: readonly string[];
}
