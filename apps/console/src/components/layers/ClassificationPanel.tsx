'use client';
// REQ-AI-002 (ADR-052) — suggested classifications on the Layers screen: each unknown CI the fingerprints recognise,
// with the suggested class, layer and type, the confidence and the evidence behind it (sysDescr, banner, vendor,
// ports). Operators accept (the suggestion becomes the CI's user label) or dismiss; the acceptance rate and the
// unknown CIs no fingerprint recognised are counted alongside.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import type { DEVICE_FINGERPRINTS} from '@openmap/constants';
import { BSM, ROLES } from '@openmap/constants';
import type { Locale, MessageKey } from '@openmap/i18n';
import { Card, LayerBadge, SectionTitle, Tag } from '@openmap/ui';
import type { ReactNode } from 'react';
import { QueryState } from '@/components/common/QueryState';
import { useCan } from '@/lib/auth';
import { classificationKey, classificationQuery, decideClassification } from '@/lib/classification-queries';
import { layerKey } from '@/lib/keys';
import { localizedHref } from '@/lib/locale-path';
import { useFormatters, useT } from '@/providers';

const primaryButton =
  'rounded-om-control-lg bg-om-cyan px-om-12 py-om-6 text-om-xs font-semibold text-om-ground transition-opacity duration-om-base hover:opacity-90 disabled:opacity-50';
const secondaryButton =
  'rounded-om-control-lg border border-om-border-strong px-om-12 py-om-6 text-om-xs font-semibold text-om-secondary transition-colors duration-om-base hover:text-om-primary disabled:opacity-50';

const SIGNAL_KEY = {
  sysDescr: 'classify.signal.sysDescr',
  banner: 'classify.signal.banner',
  vendor: 'classify.signal.vendor',
  ports: 'classify.signal.ports',
} as const satisfies Record<string, MessageKey>;

type DeviceClass = (typeof DEVICE_FINGERPRINTS)[number]['deviceClass'];
const CLASS_KEY = {
  printer: 'classify.class.printer',
  network_camera: 'classify.class.network_camera',
  ip_phone: 'classify.class.ip_phone',
  video_conference: 'classify.class.video_conference',
  digital_signage: 'classify.class.digital_signage',
  access_control: 'classify.class.access_control',
  building_management: 'classify.class.building_management',
  ups_management: 'classify.class.ups_management',
  wireless_access_point: 'classify.class.wireless_access_point',
  iot_gateway: 'classify.class.iot_gateway',
  cash_handling: 'classify.class.cash_handling',
} as const satisfies Record<DeviceClass, MessageKey>;

export function ClassificationPanel({ locale }: { locale: Locale }): ReactNode {
  const t = useT();
  const format = useFormatters();
  const operator = useCan()(ROLES.operator);
  const queryClient = useQueryClient();
  const summary = useQuery(classificationQuery());
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'accept' | 'dismiss' }) => decideClassification(input.id, input.decision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: classificationKey });
      void queryClient.invalidateQueries({ queryKey: ['layers'] });
    },
  });
  const className = (deviceClass: string): string =>
    deviceClass in CLASS_KEY ? t(CLASS_KEY[deviceClass as DeviceClass]) : deviceClass;

  return (
    <section aria-label={t('classify.title')}>
      <Card className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm" description={t('classify.description')}>
          {t('classify.title')}
        </SectionTitle>
        {summary.isPending ? (
          <QueryState status="pending" />
        ) : summary.isError ? (
          <QueryState
            status="error"
            onRetry={() => {
              void summary.refetch();
            }}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-om-8 md:grid-cols-4" role="group" aria-label={t('classify.summary')}>
              {[
                [t('classify.summary.open'), format.integer(summary.data.open.length)],
                [t('classify.summary.unrecognised'), format.integer(summary.data.unrecognised)],
                [t('classify.summary.decided'), t('classify.decided', { accepted: format.integer(summary.data.accepted), dismissed: format.integer(summary.data.dismissed) })],
                [
                  t('classify.summary.rate'),
                  summary.data.acceptanceRate === null ? t('classify.none') : t('classify.percent', { value: format.number(summary.data.acceptanceRate * BSM.percentScale) }),
                ],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-om-2 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8">
                  <span className="text-om-2xs uppercase tracking-wide text-om-muted">{label}</span>
                  <span className="text-om-md font-semibold text-om-primary">{value}</span>
                </div>
              ))}
            </div>
            {summary.data.open.length === 0 ? (
              <p className="text-om-sm text-om-secondary">{t('classify.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-om-6" aria-label={t('classify.list')}>
                {summary.data.open.map((s) => (
                  <li
                    key={s.id}
                    aria-label={s.ci.displayName}
                    className="flex flex-wrap items-start gap-om-10 rounded-om-panel border border-om-border-glass bg-om-surface2/60 px-om-10 py-om-8 text-om-sm"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-om-4">
                      <span className="flex flex-wrap items-center gap-om-6">
                        <Link href={localizedHref(locale, '/cmdb/' + encodeURIComponent(s.ci.id))} className="font-medium text-om-cyan hover:underline">
                          {s.ci.displayName}
                        </Link>
                        <span className="text-om-muted">{t('classify.arrow')}</span>
                        <Tag>{className(s.deviceClass)}</Tag>
                        <LayerBadge layer={s.layer} label={t(layerKey(s.layer))} />
                        {s.type !== null ? <span className="font-om-mono text-om-2xs text-om-secondary">{t('classify.type', { type: s.type })}</span> : null}
                        <span className="text-om-2xs text-om-muted">
                          {t('classify.confidence', { value: format.number(s.confidence * BSM.percentScale) })}
                        </span>
                      </span>
                      <span dir="ltr" className="truncate text-left font-om-mono text-om-2xs text-om-secondary rtl:text-right">
                        {s.title}
                      </span>
                      <span className="flex flex-wrap gap-om-4" aria-label={t('classify.evidence')}>
                        {s.evidence.map((e) => (
                          <Tag key={e.signal}>{t(SIGNAL_KEY[e.signal]) + ': ' + e.value}</Tag>
                        ))}
                      </span>
                    </span>
                    {operator ? (
                      <span className="flex gap-om-6">
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={decide.isPending}
                          onClick={() => {
                            decide.mutate({ id: s.id, decision: 'accept' });
                          }}
                        >
                          {t('classify.accept')}
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={decide.isPending}
                          onClick={() => {
                            decide.mutate({ id: s.id, decision: 'dismiss' });
                          }}
                        >
                          {t('classify.dismiss')}
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {decide.isError ? (
              <p role="alert" className="text-om-xs text-om-state-down">
                {t('common.error')}
              </p>
            ) : null}
          </>
        )}
      </Card>
    </section>
  );
}
