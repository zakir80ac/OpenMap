// REQ-CMDB-033 REQ-CMDB-036 (ADR-032) — imports and exports from the console: a preview reads an uploaded file with a
// mapping, a run queues it, the job list says what each import created; the CI export downloads the CMDB's current
// filter as CSV, XLSX or JSON.
import { queryOptions } from '@tanstack/react-query';
import type { ImportFormat, ImportMapping, RejectedRow } from '@openmap/contracts';
import { downloadFromApi, gql } from './graphql';
import type { CiFilterInput } from './queries';

export interface ImportInput {
  filename: string;
  format: ImportFormat;
  contentBase64: string;
  mapping: ImportMapping | null;
}

export interface ImportPreview {
  headers: string[];
  mapping: ImportMapping;
  rows: number;
  accepted: number;
  rejected: number;
  rejectedRows: RejectedRow[];
  byType: Record<string, number>;
  sample: string[][];
}

export interface ImportJob {
  id: string;
  filename: string;
  format: ImportFormat;
  rows: number;
  accepted: number;
  rejected: number;
  rejectedRows: RejectedRow[];
  byType: Record<string, number>;
  runId: string;
  created: number;
  submittedBy: string;
  createdAt: string;
}

const PREVIEW = 'mutation PreviewImport($input: ImportInput!) { previewImport(input: $input) { headers mapping rows accepted rejected rejectedRows { row reason } byType sample } }';
const RUN = 'mutation RunImport($input: ImportInput!) { runImport(input: $input) { id filename format rows accepted rejected rejectedRows { row reason } byType runId created submittedBy createdAt } }';
const JOBS = 'query ImportJobs { importJobs { id filename format rows accepted rejected rejectedRows { row reason } byType runId created submittedBy createdAt } }';

export const importJobsQueryKey = ['import-jobs'] as const;

export function previewImport(input: ImportInput): Promise<ImportPreview> {
  return gql<{ previewImport: ImportPreview }>(PREVIEW, { input }).then((d) => d.previewImport);
}

export function runImport(input: ImportInput): Promise<ImportJob> {
  return gql<{ runImport: ImportJob }>(RUN, { input }).then((d) => d.runImport);
}

export function importJobsQuery(refreshMs: number | false = false) {
  return queryOptions({
    queryKey: importJobsQueryKey,
    queryFn: ({ signal }) => gql<{ importJobs: ImportJob[] }>(JOBS, {}, signal).then((d) => d.importJobs),
    refetchInterval: refreshMs,
  });
}

export type ExportFormat = 'csv' | 'xlsx' | 'json';

/** The export route's query string for a CMDB filter. */
export function exportPath(format: ExportFormat, filter: CiFilterInput): string {
  const query = new URLSearchParams({ format });
  if (filter.types !== undefined && filter.types.length > 0) query.set('types', filter.types.join(','));
  if (filter.layers !== undefined && filter.layers.length > 0) query.set('layers', filter.layers.join(','));
  if (filter.lifecycle !== undefined && filter.lifecycle.length > 0) query.set('lifecycle', filter.lifecycle.join(','));
  if (filter.tags !== undefined && filter.tags.length > 0) query.set('tags', filter.tags.join(','));
  if (filter.text !== undefined && filter.text !== '') query.set('text', filter.text);
  return '/export/cis?' + query.toString();
}

export function exportCis(format: ExportFormat, filter: CiFilterInput): Promise<void> {
  return downloadFromApi(exportPath(format, filter), 'openmap-cis.' + format);
}

/** A browser file as base64, without the data-URL prefix. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error('the file could not be read'));
    };
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
