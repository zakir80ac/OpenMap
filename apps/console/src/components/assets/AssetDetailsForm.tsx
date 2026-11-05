'use client';
// REQ-CMDB-039 REQ-CMDB-040 — the fields a person records on an asset (ADR-023): identity, purchase, warranty, vendor
// support and end of life. One form serves the edit panel of a register row and the manual-asset entry; it builds an
// AssetDetailsInput where an empty group clears that cover and an empty field clears that value.
import { ASSETS } from '@openmap/constants';
import { isSubscriptionCiType } from '@openmap/contracts';
import type { ReactNode, SyntheticEvent } from 'react';
import { useId, useState } from 'react';
import { Button, Field, Select, TextArea, TextInput } from '@/components/common/controls';
import type { AssetDetailsInput, AssetRecord } from '@/lib/estate-queries';
import { useT } from '@/providers';

export interface AssetDetailsFormProps {
  initial: AssetRecord | null;
  /** The accessible name of the form. */
  label: string;
  submitLabel: string;
  pending: boolean;
  /** Extra fields rendered above the details (the manual entry's name, layer, type and tag). */
  head?: ReactNode;
  /** Status line rendered beside the submit control (saved, error). */
  status?: ReactNode;
  /** The CI type the asset has (or the manual entry chose): software, SaaS and cloud types take a subscription, not a warranty. */
  ciType?: string | null;
  onSubmit: (details: AssetDetailsInput) => void;
}

interface Draft {
  manufacturer: string;
  model: string;
  serialNumber: string;
  partNumber: string;
  custodian: string;
  purchasedAt: string;
  purchaseCostAmount: string;
  purchaseCostCurrency: string;
  warrantyProvider: string;
  warrantyLevel: string;
  warrantyStartsAt: string;
  warrantyEndsAt: string;
  subscriptionProvider: string;
  subscriptionPlan: string;
  subscriptionStartsAt: string;
  subscriptionEndsAt: string;
  creditsRemaining: string;
  creditsUnit: string;
  creditsCurrency: string;
  supportProvider: string;
  supportContractNumber: string;
  supportLevel: string;
  supportEndsAt: string;
  endOfSale: string;
  endOfSoftwareMaintenance: string;
  endOfSupport: string;
  note: string;
}

const DATE_LENGTH = 'YYYY-MM-DD'.length;

function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, DATE_LENGTH) : '';
}

export function draftOf(asset: AssetRecord | null): Draft {
  return {
    manufacturer: asset?.manufacturer ?? '',
    model: asset?.model ?? '',
    serialNumber: asset?.serialNumber ?? '',
    partNumber: asset?.partNumber ?? '',
    custodian: asset?.custodian ?? '',
    purchasedAt: dateOnly(asset?.purchasedAt),
    purchaseCostAmount: asset?.purchaseCost ? String(asset.purchaseCost.amount) : '',
    purchaseCostCurrency: asset?.purchaseCost?.currency ?? '',
    warrantyProvider: asset?.warranty?.provider ?? '',
    warrantyLevel: asset?.warranty?.level ?? '',
    warrantyStartsAt: dateOnly(asset?.warranty?.startsAt),
    warrantyEndsAt: dateOnly(asset?.warranty?.endsAt),
    subscriptionProvider: asset?.subscription?.provider ?? '',
    subscriptionPlan: asset?.subscription?.plan ?? '',
    subscriptionStartsAt: dateOnly(asset?.subscription?.startsAt),
    subscriptionEndsAt: dateOnly(asset?.subscription?.endsAt),
    creditsRemaining: asset?.subscription?.credits ? String(asset.subscription.credits.remaining) : '',
    creditsUnit: asset?.subscription?.credits?.unit ?? '',
    creditsCurrency: asset?.subscription?.credits?.currency ?? '',
    supportProvider: asset?.support?.provider ?? '',
    supportContractNumber: asset?.support?.contractNumber ?? '',
    supportLevel: asset?.support?.level ?? '',
    supportEndsAt: dateOnly(asset?.support?.endsAt),
    endOfSale: dateOnly(asset?.endOfLife?.endOfSale),
    endOfSoftwareMaintenance: dateOnly(asset?.endOfLife?.endOfSoftwareMaintenance),
    endOfSupport: dateOnly(asset?.endOfLife?.endOfSupport),
    note: '',
  };
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The mutation input for a draft: a cover group is sent when its end date is filled, cleared when the group is empty. */
export function detailsOf(d: Draft): AssetDetailsInput {
  const amount = orNull(d.purchaseCostAmount);
  const warrantyEmpty = [d.warrantyProvider, d.warrantyLevel, d.warrantyStartsAt, d.warrantyEndsAt].every(
    (v) => v.trim() === '',
  );
  const subscriptionEmpty = [
    d.subscriptionProvider,
    d.subscriptionPlan,
    d.subscriptionStartsAt,
    d.subscriptionEndsAt,
    d.creditsRemaining,
    d.creditsUnit,
    d.creditsCurrency,
  ].every((v) => v.trim() === '');
  const supportEmpty = [d.supportProvider, d.supportContractNumber, d.supportLevel, d.supportEndsAt].every(
    (v) => v.trim() === '',
  );
  const eolEmpty = [d.endOfSale, d.endOfSoftwareMaintenance, d.endOfSupport].every((v) => v.trim() === '');
  const input: AssetDetailsInput = {
    manufacturer: orNull(d.manufacturer),
    model: orNull(d.model),
    serialNumber: orNull(d.serialNumber),
    partNumber: orNull(d.partNumber),
    custodian: orNull(d.custodian),
    purchasedAt: orNull(d.purchasedAt),
    purchaseCostAmount: amount === null ? null : Number(amount),
    purchaseCostCurrency: amount === null ? null : orNull(d.purchaseCostCurrency.toUpperCase()),
    note: orNull(d.note),
  };
  if (warrantyEmpty) input.warranty = null;
  else if (d.warrantyProvider.trim() !== '' && d.warrantyEndsAt !== '')
    input.warranty = {
      provider: d.warrantyProvider.trim(),
      level: orNull(d.warrantyLevel),
      startsAt: orNull(d.warrantyStartsAt),
      endsAt: d.warrantyEndsAt,
    };
  if (subscriptionEmpty) input.subscription = null;
  else if (subscriptionComplete(d)) {
    const remaining = orNull(d.creditsRemaining);
    input.subscription = {
      provider: d.subscriptionProvider.trim(),
      plan: orNull(d.subscriptionPlan),
      startsAt: orNull(d.subscriptionStartsAt),
      endsAt: orNull(d.subscriptionEndsAt),
      creditsRemaining: remaining === null ? null : Number(remaining),
      creditsUnit: remaining === null ? null : orNull(d.creditsUnit),
      creditsCurrency: remaining === null ? null : orNull(d.creditsCurrency.toUpperCase()),
    };
  }
  if (supportEmpty) input.support = null;
  else if (d.supportProvider.trim() !== '' && d.supportEndsAt !== '')
    input.support = {
      provider: d.supportProvider.trim(),
      contractNumber: orNull(d.supportContractNumber),
      level: orNull(d.supportLevel),
      endsAt: d.supportEndsAt,
    };
  if (eolEmpty) input.endOfLife = null;
  else
    input.endOfLife = {
      endOfSale: orNull(d.endOfSale),
      endOfSoftwareMaintenance: orNull(d.endOfSoftwareMaintenance),
      endOfSupport: orNull(d.endOfSupport),
    };
  return input;
}

/** A subscription is complete with a provider and either an end date or a credit balance with its unit. */
export function subscriptionComplete(d: Draft): boolean {
  const remaining = d.creditsRemaining.trim();
  const credits =
    remaining !== '' &&
    Number.isFinite(Number(remaining)) &&
    Number(remaining) >= 0 &&
    d.creditsUnit.trim() !== '';
  return (
    d.subscriptionProvider.trim() !== '' &&
    (d.subscriptionEndsAt !== '' || credits) &&
    (remaining === '' || credits)
  );
}

/** A warranty or support group is complete when both the provider and the end date are filled, or it is entirely empty. */
export function draftComplete(d: Draft): boolean {
  const group = (provider: string, endsAt: string, rest: string[]): boolean => {
    const any = [provider, endsAt, ...rest].some((v) => v.trim() !== '');
    return !any || (provider.trim() !== '' && endsAt !== '');
  };
  const subscriptionAny = [
    d.subscriptionProvider,
    d.subscriptionPlan,
    d.subscriptionStartsAt,
    d.subscriptionEndsAt,
    d.creditsRemaining,
    d.creditsUnit,
    d.creditsCurrency,
  ].some((v) => v.trim() !== '');
  return (
    group(d.warrantyProvider, d.warrantyEndsAt, [d.warrantyLevel, d.warrantyStartsAt]) &&
    (!subscriptionAny || subscriptionComplete(d)) &&
    group(d.supportProvider, d.supportEndsAt, [d.supportContractNumber, d.supportLevel])
  );
}

const CURRENCY_LENGTH = 'ISO'.length;

export function AssetDetailsForm({
  initial,
  label,
  submitLabel,
  pending,
  head,
  status,
  ciType,
  onSubmit,
}: AssetDetailsFormProps): ReactNode {
  const t = useT();
  const id = useId();
  const subscriptionType = isSubscriptionCiType(ciType ?? initial?.ciType ?? null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const set =
    (key: keyof Draft) =>
    (event: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = event.currentTarget.value;
      setDraft((d) => ({ ...d, [key]: value }));
    };
  const field = (
    key: keyof Draft,
    labelKey: Parameters<typeof t>[0],
    type: 'text' | 'date' | 'number' = 'text',
    extra?: { maxLength?: number; min?: number; step?: string },
  ): ReactNode => (
    <Field id={id + key} label={t(labelKey)}>
      <TextInput
        id={id + key}
        type={type}
        value={draft[key]}
        onChange={set(key)}
        maxLength={extra?.maxLength}
        min={extra?.min}
        step={extra?.step}
      />
    </Field>
  );
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draftComplete(draft)) return;
    onSubmit(detailsOf(draft));
  };
  const group = (title: string, children: ReactNode): ReactNode => (
    <fieldset className="grid grid-cols-1 gap-om-10 rounded-om-panel border border-om-border-glass p-om-12 md:grid-cols-2">
      <legend className="px-om-6 text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-secondary">
        {title}
      </legend>
      {children}
    </fieldset>
  );
  return (
    <form aria-label={label} onSubmit={submit} className="flex flex-col gap-om-12">
      {head}
      {group(
        t('assets.details.identity'),
        <>
          {field('manufacturer', 'assets.details.manufacturer')}
          {field('model', 'assets.details.model')}
          {field('serialNumber', 'assets.details.serialNumber')}
          {field('partNumber', 'assets.details.partNumber')}
          {field('custodian', 'assets.details.custodian')}
          {field('purchasedAt', 'assets.details.purchasedAt', 'date')}
          {field('purchaseCostAmount', 'assets.details.purchaseCost', 'number', { min: 0, step: 'any' })}
          <Field id={id + 'purchaseCostCurrency'} label={t('assets.details.currency')}>
            <TextInput
              id={id + 'purchaseCostCurrency'}
              value={draft.purchaseCostCurrency}
              onChange={set('purchaseCostCurrency')}
              maxLength={CURRENCY_LENGTH}
              className="uppercase"
            />
          </Field>
        </>,
      )}
      {subscriptionType
        ? group(
            t('assets.details.subscription.title'),
            <>
              {field('subscriptionProvider', 'assets.details.subscription.provider')}
              {field('subscriptionPlan', 'assets.details.subscription.plan')}
              {field('subscriptionStartsAt', 'assets.details.subscription.startsAt', 'date')}
              {field('subscriptionEndsAt', 'assets.details.subscription.endsAt', 'date')}
              {field('creditsRemaining', 'assets.details.subscription.creditsRemaining', 'number', {
                min: 0,
                step: 'any',
              })}
              {field('creditsUnit', 'assets.details.subscription.creditsUnit')}
              <Field id={id + 'creditsCurrency'} label={t('assets.details.subscription.creditsCurrency')}>
                <TextInput
                  id={id + 'creditsCurrency'}
                  value={draft.creditsCurrency}
                  onChange={set('creditsCurrency')}
                  maxLength={CURRENCY_LENGTH}
                  className="uppercase"
                />
              </Field>
            </>,
          )
        : group(
            t('assets.details.warranty.title'),
            <>
              {field('warrantyProvider', 'assets.details.warranty.provider')}
              {field('warrantyLevel', 'assets.details.warranty.level')}
              {field('warrantyStartsAt', 'assets.details.warranty.startsAt', 'date')}
              {field('warrantyEndsAt', 'assets.details.warranty.endsAt', 'date')}
            </>,
          )}
      {group(
        t('assets.details.support.title'),
        <>
          {field('supportProvider', 'assets.details.support.provider')}
          {field('supportContractNumber', 'assets.details.support.contractNumber')}
          {field('supportLevel', 'assets.details.support.level')}
          {field('supportEndsAt', 'assets.details.support.endsAt', 'date')}
        </>,
      )}
      {group(
        t('assets.details.eol.title'),
        <>
          {field('endOfSale', 'assets.details.eol.endOfSale', 'date')}
          {field('endOfSoftwareMaintenance', 'assets.details.eol.endOfSoftwareMaintenance', 'date')}
          {field('endOfSupport', 'assets.details.eol.endOfSupport', 'date')}
        </>,
      )}
      <Field id={id + 'note'} label={t('assets.details.note')}>
        <TextArea id={id + 'note'} value={draft.note} onChange={set('note')} rows={ASSETS.noteRows} />
      </Field>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" tone="primary" disabled={pending || !draftComplete(draft)}>
          {pending ? t('common.saving') : submitLabel}
        </Button>
        {status}
      </div>
    </form>
  );
}

/** Re-exported for the manual form's layer/type selectors, which share the control styling. */
export { Select };
