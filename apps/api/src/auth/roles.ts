// REQ-CORE-012 — realm roles the Keycloak realm import (deploy/compose/keycloak/realm-openmap.json)
// defines. admin implies operator, operator implies analyst, auditor implies analyst; `node` is the
// Discovery Node service identity and grants no console access.
export const ROLES = {
  admin: 'openmap-admin',
  operator: 'openmap-operator',
  analyst: 'openmap-analyst',
  auditor: 'openmap-auditor',
  node: 'openmap-node',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

const IMPLIED: Record<Role, readonly Role[]> = {
  [ROLES.admin]: [ROLES.admin, ROLES.operator, ROLES.analyst, ROLES.auditor],
  [ROLES.operator]: [ROLES.operator, ROLES.analyst],
  [ROLES.analyst]: [ROLES.analyst],
  [ROLES.auditor]: [ROLES.auditor, ROLES.analyst],
  [ROLES.node]: [ROLES.node],
};

const ALL = new Set<string>(Object.values(ROLES));

export function isRole(value: string): value is Role {
  return ALL.has(value);
}

/** Effective roles after implication. Unknown realm roles are kept verbatim so audit logs show them. */
export function effectiveRoles(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of granted) {
    out.add(r);
    if (isRole(r)) for (const i of IMPLIED[r]) out.add(i);
  }
  return out;
}

export function hasAnyRole(granted: readonly string[], required: readonly Role[]): boolean {
  const effective = effectiveRoles(granted);
  return required.some((r) => effective.has(r));
}
