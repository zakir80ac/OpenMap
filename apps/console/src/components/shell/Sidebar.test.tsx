// REQ-UI-003 — Sidebar renders every navigation key in en and ar and marks exactly one route as current.
import { cleanup, render, screen, within } from '@testing-library/react';
import { LOCALES, translate } from '@openmap/i18n';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/providers';
import { NAV_GROUPS, NAV_ITEMS } from './nav';
import { Sidebar } from './Sidebar';

const pathname = vi.hoisted(() => ({ current: '/en/dashboard' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe.each(LOCALES)('Sidebar in %s', (locale) => {
  it('renders every nav item with its translated label and locale-prefixed href', () => {
    pathname.current = '/' + locale + '/dashboard';
    render(
      <Providers locale={locale}>
        <Sidebar locale={locale} />
      </Providers>,
    );
    const nav = screen.getByRole('navigation', { name: translate(locale, 'nav.primary') });
    for (const item of NAV_ITEMS) {
      const link = within(nav).getByRole('link', { name: translate(locale, item.key) });
      expect(link.getAttribute('href')).toBe('/' + locale + item.href);
    }
    for (const group of NAV_GROUPS) {
      if (group.key !== undefined) expect(within(nav).getByText(translate(locale, group.key))).toBeTruthy();
    }
    expect(within(nav).getAllByRole('link')).toHaveLength(NAV_ITEMS.length);
  });

  it('highlights the active route and only that route', () => {
    pathname.current = '/' + locale + '/cmdb/some-ci';
    render(
      <Providers locale={locale}>
        <Sidebar locale={locale} />
      </Providers>,
    );
    const nav = screen.getByRole('navigation', { name: translate(locale, 'nav.primary') });
    const current = within(nav).getAllByRole('link', { current: 'page' });
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe(translate(locale, 'nav.cmdb'));
    expect(current[0]?.className).toContain('shadow-om-glow-nav-cyan');
    const inactive = within(nav).getByRole('link', { name: translate(locale, 'nav.dashboard') });
    expect(inactive.getAttribute('aria-current')).toBeNull();
    expect(inactive.className).not.toContain('shadow-om-glow-nav-cyan');
  });
});
