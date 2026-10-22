// REQ-SEC-001 — role implication for the console, over the same table the API guard uses (@openmap/constants).
// The console only hides or disables what the API would refuse; the API remains the authority.
import { ROLES, ROLE_IMPLICATIONS, type Role } from '@openmap/constants';

const ALL = new Set<string>(Object.values(ROLES));

export function isRole(value: string): value is Role {
  return ALL.has(value);
}

export function effectiveRoles(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const r of granted) {
    out.add(r);
    if (isRole(r)) for (const implied of ROLE_IMPLICATIONS[r]) out.add(implied);
  }
  return out;
}

export function hasRole(granted: readonly string[], required: Role): boolean {
  return effectiveRoles(granted).has(required);
}
