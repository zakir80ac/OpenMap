// REQ-UI-003 — the console's navigation model: groups and items keyed to i18n keys and locale-relative routes.
import type { MessageKey } from '@openmap/i18n';
import type { IconName } from '@/components/icons';

export interface NavItem {
  key: MessageKey;
  /** Route without the locale prefix. */
  href: `/${string}`;
  icon: IconName;
}

export interface NavGroup {
  /** Group heading; the first and last groups are unlabelled. */
  key?: MessageKey;
  items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    items: [
      { key: 'nav.dashboard', href: '/dashboard', icon: 'dashboard' },
      { key: 'nav.twin', href: '/twin', icon: 'twin' },
      { key: 'nav.setup', href: '/setup', icon: 'play' },
      { key: 'nav.layers', href: '/layers', icon: 'layers' },
    ],
  },
  {
    key: 'nav.group.discover',
    items: [
      { key: 'nav.discovery', href: '/discovery', icon: 'discovery' },
      { key: 'nav.dependencies', href: '/dependencies', icon: 'dependencies' },
      { key: 'nav.cmdb', href: '/cmdb', icon: 'cmdb' },
      { key: 'nav.assets', href: '/assets', icon: 'assets' },
      { key: 'nav.parts', href: '/parts', icon: 'chip' },
      { key: 'nav.software', href: '/software', icon: 'software' },
      { key: 'nav.saas', href: '/saas', icon: 'globe' },
      { key: 'nav.commercial', href: '/commercial', icon: 'contract' },
    ],
  },
  {
    key: 'nav.group.services',
    items: [
      { key: 'nav.services', href: '/services', icon: 'services' },
      { key: 'nav.sites', href: '/sites', icon: 'site' },
      { key: 'nav.impact', href: '/impact', icon: 'impact' },
      { key: 'nav.integrations', href: '/integrations', icon: 'integrations' },
    ],
  },
  {
    key: 'nav.group.infrastructure',
    items: [
      { key: 'nav.ipam', href: '/ipam', icon: 'ipam' },
      { key: 'nav.dcim', href: '/dcim', icon: 'dcim' },
    ],
  },
  {
    key: 'nav.group.insight',
    items: [
      { key: 'nav.vulnerabilities', href: '/vulnerabilities', icon: 'shield' },
      { key: 'nav.certificates', href: '/certificates', icon: 'certificate' },
      { key: 'nav.telemetry', href: '/telemetry', icon: 'eye' },
      { key: 'nav.utilisation', href: '/utilisation', icon: 'analytics' },
      { key: 'nav.lifecycle', href: '/lifecycle', icon: 'clock' },
      { key: 'nav.analytics', href: '/analytics', icon: 'analytics' },
      { key: 'nav.anomalies', href: '/anomalies', icon: 'shield' },
      { key: 'nav.assistant', href: '/assistant', icon: 'assistant' },
    ],
  },
  {
    items: [
      // REQ-PERF-005: the platform's own health, beside Settings (administrators).
      { key: 'nav.platform', href: '/platform', icon: 'eye' },
      { key: 'nav.settings', href: '/settings', icon: 'settings' },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Active when the locale-stripped pathname is the route or a descendant of it. */
export function isActiveRoute(pathWithoutLocale: string, href: string): boolean {
  return pathWithoutLocale === href || pathWithoutLocale.startsWith(href + '/');
}
