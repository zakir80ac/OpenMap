'use client';
// REQ-SEC-001 REQ-UI-003 — top-bar account control: avatar initial opens a glass popover with the display name and
// username from the id token, the tenant claim, every realm role as a Tag, and Sign out (Keycloak end_session).
import { GlassPanel, Tag, accents } from '@openmap/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { useAuth } from '@/lib/auth';
import { useT } from '@/providers';

export function UserMenu(): ReactNode {
  const t = useT();
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const user = auth.user;
  const name = user?.displayName ?? '';
  const initial = name === '' ? (user?.username.charAt(0) ?? '') : name.charAt(0);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={t('auth.menu')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="grid size-8 place-items-center rounded-om-pill border border-om-border-strong bg-om-surface2 font-om-display text-om-xs font-bold uppercase text-om-primary transition-[box-shadow,border-color] duration-om-base ease-om-standard hover:border-om-cyan/40 hover:shadow-om-glow-bar-cyan aria-expanded:border-om-cyan/40 aria-expanded:shadow-om-glow-bar-cyan"
      >
        {initial === '' ? <Icon name="user" className="size-4" /> : initial}
      </button>
      {open && user !== undefined ? (
        <div id={panelId} role="dialog" aria-label={t('auth.menu')} className="absolute end-0 top-[calc(100%+var(--om-space-8))] z-20 w-72">
          <GlassPanel accent={accents.cyan} padding="16" className="shadow-om-card">
          <div className="flex flex-col gap-om-14">
            <div className="flex items-center gap-om-12">
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-om-pill border border-om-cyan/40 bg-om-cyan/15 font-om-display text-om-sm font-bold uppercase text-om-cyan">
                {initial === '' ? <Icon name="user" className="size-4" /> : initial}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-om-display text-om-sm font-semibold text-om-primary">{name === '' ? user.username : name}</span>
                {name !== '' && name !== user.username ? <span className="truncate font-om-mono text-om-2xs text-om-muted">{user.username}</span> : null}
                {user.email !== undefined ? <span className="truncate text-om-2xs text-om-muted">{user.email}</span> : null}
              </div>
            </div>

            <dl className="flex flex-col gap-om-10 text-om-xs">
              <div className="flex items-center justify-between gap-om-8">
                <dt className="text-om-muted">{t('auth.tenant')}</dt>
                <dd className="m-0">
                  {user.tenant !== undefined ? (
                    <Tag icon={<Icon name="site" className="size-3" />}>{user.tenant}</Tag>
                  ) : (
                    <span className="text-om-secondary">{t('common.none')}</span>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-om-6">
                <dt className="text-om-muted">{t('auth.roles')}</dt>
                <dd className="m-0 flex flex-wrap gap-om-6">
                  {user.roles.length === 0 ? (
                    <span className="text-om-secondary">{t('auth.noRoles')}</span>
                  ) : (
                    user.roles.map((role) => (
                      <Tag key={role} variant="state" state="healthy" icon={<Icon name="tag" className="size-3" />}>
                        {role}
                      </Tag>
                    ))
                  )}
                </dd>
              </div>
            </dl>

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void auth.signOut();
              }}
              className="flex h-9 w-full items-center justify-center gap-om-8 rounded-om-control-lg border border-om-border-strong bg-om-surface3 text-om-sm font-medium text-om-primary transition-colors duration-om-base ease-om-standard hover:border-om-rose/40 hover:text-om-rose"
            >
              <Icon name="signOut" className="size-4 rtl:-scale-x-100" />
              <span>{t('auth.signOut')}</span>
            </button>
          </div>
          </GlassPanel>
        </div>
      ) : null}
    </div>
  );
}
