'use client';
// REQ-CMDB-020 — receiving against an infrastructure plan's bill of materials (ADR-034, ADR-005: plans, not purchase
// orders). An operator receives units of one line: one serial per line of the box (a tag may follow after a comma or a
// tab, as a scanner or a spreadsheet paste gives them), the day the goods arrived, the ERP order or delivery note
// reference and, when the plan names them, the site or rack the goods are stored at. The plan lists its receipts.
import { useMutation } from '@tanstack/react-query';
import { ASSETS, BSM } from '@openmap/constants';
import { parseReceivedUnits, type ReceivedUnitsProblem } from '@openmap/contracts';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import {
  Button,
  Field,
  Select,
  TextArea,
  TextInput,
  rowClass,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from '@/components/common/controls';
import {
  receivePlanLine,
  type BomLine,
  type InfraPlan,
  type PlanReceipt,
  type ReceiptInput,
} from '@/lib/estate-queries';
import { useFormatters, useT } from '@/providers';

/** Length of a calendar date (YYYY-MM-DD), the form of a date field's value. */
const DAY_LENGTH = 'YYYY-MM-DD'.length;

/** Today on the person's own calendar, as a date field's value. */
export function localToday(now: Date = new Date()): string {
  const offsetMs = now.getTimezoneOffset() * BSM.msPerMinute;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, DAY_LENGTH);
}

/** What the receive form sends for what was typed; blank optional fields are left out. */
export function toReceiptInput(
  plan: InfraPlan,
  line: BomLine,
  draft: { units: ReceiptInput['units']; receivedOn: string; reference: string; locationId: string },
): ReceiptInput {
  const input: ReceiptInput = { planId: plan.id, position: line.position, receivedOn: draft.receivedOn, units: draft.units };
  if (draft.reference.trim() !== '') input.reference = draft.reference.trim();
  if (draft.locationId !== '') input.locationId = draft.locationId;
  return input;
}

function useProblemText(): (problem: ReceivedUnitsProblem) => string {
  const t = useT();
  const format = useFormatters();
  return (problem) => {
    switch (problem.kind) {
      case 'empty':
        return t('assets.receive.problem.empty');
      case 'duplicate':
        return t('assets.receive.problem.duplicate', { serial: problem.serialNumber });
      case 'too_many':
        return t('assets.receive.problem.tooMany', {
          count: format.integer(problem.count),
          outstanding: format.integer(problem.outstanding),
        });
    }
  };
}

export interface ReceiveLineFormProps {
  plan: InfraPlan;
  line: BomLine;
  onReceived: (receipt: PlanReceipt) => void;
  onCancel: () => void;
}

export function ReceiveLineForm({ plan, line, onReceived, onCancel }: ReceiveLineFormProps): ReactNode {
  const t = useT();
  const format = useFormatters();
  const id = useId();
  const problemText = useProblemText();
  const [unitsText, setUnitsText] = useState('');
  const [receivedOn, setReceivedOn] = useState(() => localToday());
  const [reference, setReference] = useState('');
  const [locationId, setLocationId] = useState('');
  const [touched, setTouched] = useState(false);
  const mutation = useMutation({ mutationFn: receivePlanLine, onSuccess: onReceived });
  const parsed = parseReceivedUnits(unitsText, line.outstanding);
  const locations = [...(plan.targetSite === null ? [] : [plan.targetSite]), ...plan.targetRacks];
  const valid = parsed.problem === null && receivedOn !== '';

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setTouched(true);
    if (!valid) return;
    mutation.mutate(toReceiptInput(plan, line, { units: parsed.units, receivedOn, reference, locationId }));
  };

  return (
    <form
      onSubmit={onSubmit}
      aria-label={t('assets.receive.title', { line: line.description })}
      data-testid="receive-line-form"
      className="flex flex-col gap-om-12 rounded-om-panel border border-dashed border-om-border-strong p-om-16"
    >
      <div className="flex flex-wrap items-baseline gap-om-10">
        <h4 className="font-om-display text-om-sm font-semibold text-om-primary">
          {t('assets.receive.title', { line: line.description })}
        </h4>
        <span className="text-om-xs text-om-secondary">
          {t('assets.receive.outstanding', { count: format.integer(line.outstanding) })}
        </span>
      </div>
      <Field id={id + '-units'} label={t('assets.receive.units')} hint={t('assets.receive.unitsHint')}>
        <TextArea
          id={id + '-units'}
          rows={ASSETS.receiptSerialRows}
          value={unitsText}
          spellCheck={false}
          className="font-om-mono"
          onChange={(event) => {
            setUnitsText(event.target.value);
          }}
        />
      </Field>
      <div className="grid grid-cols-1 gap-om-12 md:grid-cols-3">
        <Field id={id + '-on'} label={t('assets.receive.receivedOn')}>
          <TextInput
            id={id + '-on'}
            type="date"
            required
            value={receivedOn}
            onChange={(event) => {
              setReceivedOn(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-ref'} label={t('assets.receive.reference')} hint={t('assets.receive.referenceHint')}>
          <TextInput
            id={id + '-ref'}
            value={reference}
            maxLength={ASSETS.receiptReferenceMaxLength}
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
        </Field>
        <Field id={id + '-loc'} label={t('assets.receive.location')}>
          <Select
            id={id + '-loc'}
            value={locationId}
            disabled={locations.length === 0}
            onChange={(event) => {
              setLocationId(event.target.value);
            }}
          >
            <option value="">{t('common.none')}</option>
            {locations.map((ci) => (
              <option key={ci.id} value={ci.id}>
                {ci.displayName}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-om-10">
        <Button type="submit" disabled={mutation.isPending}>
          {t('assets.receive.submit', { count: format.integer(parsed.units.length) })}
        </Button>
        <Button tone="quiet" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {touched && parsed.problem !== null ? (
          <span role="alert" className="text-om-xs text-om-state-down">
            {problemText(parsed.problem)}
          </span>
        ) : mutation.isError ? (
          <span role="alert" className="text-om-xs text-om-state-down">
            {mutation.error instanceof Error ? mutation.error.message : t('assets.receive.error')}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function PlanReceipts({ receipts }: { receipts: readonly PlanReceipt[] }): ReactNode {
  const t = useT();
  const format = useFormatters();
  return (
    <div className="flex flex-col gap-om-6" data-testid="plan-receipts">
      <h4 className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('assets.receive.receipts')}</h4>
      <div className="overflow-x-auto">
        <table className={tableClass}>
          <thead className={theadClass}>
            <tr>
              <th scope="col" className={thClass}>
                {t('assets.receive.receivedOn')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.description')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.plans.bom.quantity')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.receive.reference')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.receive.serials')}
              </th>
              <th scope="col" className={thClass}>
                {t('assets.receive.by')}
              </th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((receipt) => (
              <tr key={receipt.id} className={rowClass}>
                <td className={tdClass + ' text-om-secondary'}>{format.date(receipt.receivedOn)}</td>
                <td className={tdClass + ' text-om-primary'}>
                  {receipt.description}
                  {receipt.location !== null ? (
                    <span className="block text-om-2xs text-om-muted">
                      {t('assets.receive.storedAt', { location: receipt.location.displayName })}
                    </span>
                  ) : null}
                </td>
                <td className={tdClass + ' font-om-mono text-om-secondary'}>{format.integer(receipt.quantity)}</td>
                <td className={tdClass + ' font-om-mono text-om-secondary'}>{receipt.reference ?? t('common.none')}</td>
                <td className={tdClass + ' font-om-mono text-om-2xs text-om-secondary'}>
                  {receipt.assets.map((a) => (
                    <span key={a.id} className="block">
                      {a.serialNumber ?? a.assetTag} · {a.assetTag}
                    </span>
                  ))}
                </td>
                <td className={tdClass + ' text-om-secondary'}>{receipt.receivedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
