// REQ-CMDB-033 REQ-CMDB-036 — CMDB import route: a spreadsheet or another CMDB's export into the CMDB through the
// reconciler, with a mapping, a preview and the list of past imports.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ImportView } from '@/components/cmdb/ImportView';
import { getT, requireLocale } from '@/lib/i18n';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const t = getT(await requireLocale(params));
  return { title: t('import.title') };
}

export default function CmdbImportPage(): ReactNode {
  return <ImportView />;
}
