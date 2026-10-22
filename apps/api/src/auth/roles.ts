// REQ-CORE-012 — realm-role helpers over the shared role table in @openmap/constants (the same table the console
// uses to gate actions, REQ-SEC-001). admin implies operator, operator implies analyst, auditor implies analyst;
// `node` is the Discovery Node service identity and grants no console access.
import { ROLES, ROLE_IMPLICATIONS, type Role } from '@openmap/constants';

export { ROLES, type Role };

const ALL = new Set<string>(Object.values(ROLES));

export function isRole(value: string): value is Role {
  return ALL.has(value);
}

/** Effective roles after implication. Unknown realm roles are kept verbatim so audit logs show them. */
export function effectiveRoles(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of granted) {
    out.add(r);
    if (isRole(r)) for (const i of ROLE_IMPLICATIONS[r]) out.add(i);
  }
  return out;
}

export function hasAnyRole(granted: readonly string[], required: readonly Role[]): boolean {
  const effective = effectiveRoles(granted);
  return required.some((r) => effective.has(r));
}
