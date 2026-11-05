'use client';
// REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — importing into the CMDB: an operator chooses a CSV or XLSX file (a spreadsheet,
// an OpenMap export, or another CMDB's export: a ServiceNow `cmdb_ci` export is recognised), the API proposes a mapping
// from the headers, the operator adjusts what each column holds and the default type, the preview says how many rows
// would be queued per type and which are refused and why, and the import queues them for the reconciler. Imported
// values fill what discovery has not observed and never overwrite it. The job list shows what each import created.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BYTES, IMPORTS, ROLES, TIME } from '@openmap/constants';
import { CI_IDENTITY_KEYS, CI_TYPES, IMPORT_TARGET_PATTERN, attributeKey, type CiType, type ImportFormat, type ImportMapping } from '@openmap/contracts';
import { Card, SectionTitle, Tag } from '@openmap/ui';
import { useId, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, Field, Select, rowClass, tableClass, tdClass, thClass, theadClass } from '@/components/common/controls';
import { useCan } from '@/lib/auth';
import { fileToBase64, importJobsQuery, importJobsQueryKey, previewImport, runImport, type ImportInput, type ImportPreview } from '@/lib/import-queries';
import { useFormatters, useT } from '@/providers';

interface Upload {
  filename: string;
  format: ImportFormat;
  contentBase64: string;
}

/** The targets a column may take for the mapping's types: fixed targets, every identity key, the column as an attribute. */
export function targetsFor(header: string, types: readonly CiType[]): string[] {
  const keys: string[] = [];
  for (const type of types.length === 0 ? CI_TYPES : types) for (const k of CI_IDENTITY_KEYS[type]) if (!keys.includes(k)) keys.push(k);
  const attribute = attributeKey(header);
  const out = ['ignore', 'name', 'type', 'tags', ...keys.map((k) => 'identity.' + k)];
  if (attribute !== null) out.push('attribute.' + attribute);
  return out;
}

/** The format from a file name; anything that is not .xlsx is read as CSV. */
export function formatOf(filename: string): ImportFormat {
  return filename.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
}

export function ImportView(): ReactNode {
  const t = useT();
  const format = useFormatters();
  const can = useCan();
  const fileId = useId();
  const typeId = useId();
  const queryClient = useQueryClient();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<ImportMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [readError, setReadError] = useState(false);
  const jobs = useQuery(importJobsQuery(TIME.msPerSecond * TIME.secondsPerMinute));
  const check = useMutation({
    mutationFn: (input: ImportInput) => previewImport(input),
    onSuccess: (result) => {
      setPreview(result);
      setMapping(result.mapping);
    },
  });
  const run = useMutation({
    mutationFn: (input: ImportInput) => runImport(input),
    onSuccess: async () => {
      setUpload(null);
      setPreview(null);
      setMapping(null);
      await queryClient.invalidateQueries({ queryKey: importJobsQueryKey });
    },
  });
  const operator = can(ROLES.operator);
  const types = useMemo<CiType[]>(() => {
    const out = new Set<CiType>(Object.values(mapping?.typeMap ?? {}));
    if (mapping?.defaultType) out.add(mapping.defaultType);
    return [...out];
  }, [mapping]);

  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    setReadError(false);
    setPreview(null);
    setMapping(null);
    if (file === undefined) return;
    if (file.size > IMPORTS.maxFileBytes) {
      setReadError(true);
      return;
    }
    try {
      const next = { filename: file.name, format: formatOf(file.name), contentBase64: await fileToBase64(file) };
      setUpload(next);
      check.mutate({ ...next, mapping: null });
    } catch {
      setReadError(true);
    }
  };
  const setColumn = (header: string, target: string): void => {
    if (mapping === null || !IMPORT_TARGET_PATTERN.test(target)) return;
    setMapping({ ...mapping, columns: { ...mapping.columns, [header]: target } });
  };
  const recheck = (): void => {
    if (upload !== null && mapping !== null) check.mutate({ ...upload, mapping });
  };

  return (
    <div className="flex flex-col gap-om-24">
      <SectionTitle as="h1" size="lg" eyebrow={t('app.name')} description={t('import.subtitle')}>
        {t('import.title')}
      </SectionTitle>

      {operator ? (
        <Card as="section" className="flex flex-col gap-om-12">
          <Field id={fileId} label={t('import.file')} hint={t('import.fileHint', { mb: format.integer(IMPORTS.maxFileBytes / (BYTES.perUnit * BYTES.perUnit)) })}>
            <input
              id={fileId}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                void onFile(event);
              }}
              className="text-om-sm text-om-secondary"
            />
          </Field>
          {readError ? (
            <p role="alert" className="text-om-sm text-om-rose">
              {t('import.readError')}
            </p>
          ) : null}
          {check.isPending ? <p role="status" className="text-om-sm text-om-secondary">{t('import.reading')}</p> : null}
          {check.isError ? (
            <p role="alert" className="text-om-sm text-om-rose">
              {check.error instanceof Error ? check.error.message : t('import.readError')}
            </p>
          ) : null}
        </Card>
      ) : (
        <p className="text-om-sm text-om-secondary">{t('import.operatorsOnly')}</p>
      )}

      {preview !== null && mapping !== null && upload !== null ? (
        <div data-testid="import-preview">
        <Card as="section" className="flex flex-col gap-om-16">
          <div className="flex flex-wrap items-center gap-om-8">
            <SectionTitle as="h2" size="sm">
              {upload.filename}
            </SectionTitle>
            {Object.keys(mapping.typeMap).length > 0 ? <Tag>{t('import.recognised')}</Tag> : null}
          </div>
          <p role="status" className="text-om-sm text-om-secondary" data-testid="import-summary">
            {t('import.summary', { rows: format.integer(preview.rows), accepted: format.integer(preview.accepted), rejected: format.integer(preview.rejected) })}
            {Object.keys(preview.byType).length > 0 ? ' · ' + Object.entries(preview.byType).map(([type, n]) => type + ' ' + format.integer(n)).join(', ') : ''}
          </p>
          <Field id={typeId} label={t('import.defaultType')} hint={t('import.defaultTypeHint')} className="max-w-sm">
            <Select
              id={typeId}
              value={mapping.defaultType ?? ''}
              onChange={(event) => {
                setMapping({ ...mapping, defaultType: event.target.value === '' ? null : (event.target.value as CiType) });
              }}
            >
              <option value="">{t('import.noDefault')}</option>
              {CI_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>
          <div className="overflow-x-auto">
            <table className={tableClass} aria-label={t('import.mapping')}>
              <thead className={theadClass}>
                <tr>
                  <th scope="col" className={thClass}>{t('import.column')}</th>
                  <th scope="col" className={thClass}>{t('import.target')}</th>
                  <th scope="col" className={thClass}>{t('import.example')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.headers.map((header, index) => (
                  <tr key={header + String(index)} className={rowClass}>
                    <td className={tdClass + ' font-om-mono'}>{header}</td>
                    <td className={tdClass}>
                      <Select
                        aria-label={t('import.targetFor', { column: header })}
                        value={mapping.columns[header] ?? 'ignore'}
                        onChange={(event) => {
                          setColumn(header, event.target.value);
                        }}
                        className="w-auto"
                      >
                        {[...new Set([mapping.columns[header] ?? 'ignore', ...targetsFor(header, types)])].map((target) => (
                          <option key={target} value={target}>
                            {target === 'ignore' ? t('import.ignore') : target}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className={tdClass + ' truncate text-om-2xs text-om-secondary'}>{preview.sample[0]?.[index] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rejectedRows.length > 0 ? (
            <div className="flex flex-col gap-om-6">
              <span className="text-om-2xs font-semibold uppercase tracking-[0.08em] text-om-muted">{t('import.rejected')}</span>
              <ul className="flex max-h-48 flex-col gap-om-2 overflow-y-auto text-om-xs text-om-secondary" data-testid="import-rejected">
                {preview.rejectedRows.map((r) => (
                  <li key={r.row}>{t('import.rejectedRow', { row: format.integer(r.row), reason: r.reason })}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-om-8">
            <Button tone="quiet" onClick={recheck} disabled={check.isPending}>
              {t('import.recheck')}
            </Button>
            <Button
              onClick={() => {
                run.mutate({ ...upload, mapping });
              }}
              disabled={run.isPending || check.isPending || preview.accepted === 0}
            >
              {t('import.run', { count: format.integer(preview.accepted) })}
            </Button>
            <span className="text-om-2xs text-om-muted">{t('import.precedence')}</span>
            {run.isError ? (
              <span role="alert" className="text-om-2xs text-om-rose">
                {run.error instanceof Error ? run.error.message : t('import.readError')}
              </span>
            ) : null}
          </div>
        </Card>
        </div>
      ) : null}

      <Card as="section" className="flex flex-col gap-om-12">
        <SectionTitle as="h2" size="sm">
          {t('import.jobs')}
        </SectionTitle>
        {(jobs.data ?? []).length === 0 ? (
          <p className="text-om-sm text-om-secondary">{t('import.noJobs')}</p>
        ) : (
          <table className={tableClass} aria-label={t('import.jobs')}>
            <thead className={theadClass}>
              <tr>
                <th scope="col" className={thClass}>{t('import.job.file')}</th>
                <th scope="col" className={thClass}>{t('import.job.when')}</th>
                <th scope="col" className={thClass}>{t('import.job.queued')}</th>
                <th scope="col" className={thClass}>{t('import.job.rejected')}</th>
                <th scope="col" className={thClass}>{t('import.job.created')}</th>
              </tr>
            </thead>
            <tbody>
              {(jobs.data ?? []).map((job) => (
                <tr key={job.id} className={rowClass} data-testid="import-job">
                  <td className={tdClass}>{job.filename}</td>
                  <td className={tdClass + ' text-om-2xs'}>{format.dateTime(job.createdAt) + ' · ' + job.submittedBy}</td>
                  <td className={tdClass}>{format.integer(job.accepted)}</td>
                  <td className={tdClass}>{format.integer(job.rejected)}</td>
                  <td className={tdClass} data-testid="import-job-created">{format.integer(job.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
