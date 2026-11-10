// REQ-INT-019 (ADR-066) — the backup sets this deployment keeps, read from their manifests under BACKUP_DIR (the backup
// volume, mounted read-only): newest first, and whether the newest complete set is recent enough. Prometheus reads
// `openmap_backup_last_complete_timestamp_seconds` at scrape time (0 when there is none), so a stale backup can alert
// without anyone opening the console.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { BACKUP, TIME } from '@openmap/constants';
import { backupManifestSchema, backupsStale, newestComplete, type BackupManifest } from '@openmap/contracts';
import { withSpan } from '@openmap/telemetry';
import { Gauge } from 'prom-client';
import { ENV, type Env } from '../config/env.module.js';
import { TRACER_NAME } from '../metrics/graphql-metrics.hook.js';
import { MetricsService } from '../metrics/metrics.service.js';

export const BACKUP_FRESHNESS_METRIC = 'openmap_backup_last_complete_timestamp_seconds';

export interface BackupSetView {
  name: string;
  status: BackupManifest['status'];
  createdAt: string;
  completedAt: string | null;
  postgresBytes: number | null;
  clickhouseBytes: number | null;
  migration: string | null;
  cis: number | null;
  error: string | null;
}

export interface BackupsView {
  configured: boolean;
  stale: boolean;
  staleAfterHours: number;
  lastCompleteAt: string | null;
  sets: BackupSetView[];
}

@Injectable()
export class BackupsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    metrics: MetricsService,
  ) {
    const read = (): Promise<BackupManifest[]> => this.manifests();
    new Gauge({
      name: BACKUP_FRESHNESS_METRIC,
      help: 'Completion time of the newest complete backup set (Unix seconds; 0 when there is none)',
      registers: [metrics.registry],
      async collect() {
        const newest = newestComplete(await read());
        this.set(newest?.completedAt ? Date.parse(newest.completedAt) / TIME.msPerSecond : 0);
      },
    });
  }

  /** Every readable manifest under BACKUP_DIR; a set without one, or with one that does not parse, is left out. */
  async manifests(): Promise<BackupManifest[]> {
    const dir = this.env.BACKUP_DIR;
    if (dir === undefined) return [];
    let names: string[];
    try {
      names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
    const out: BackupManifest[] = [];
    for (const name of names) {
      try {
        const parsed = backupManifestSchema.safeParse(
          JSON.parse(await readFile(join(dir, name, BACKUP.manifestFile), 'utf8')),
        );
        if (parsed.success) out.push(parsed.data);
      } catch {
        // A set still being written, or a directory that is not a backup set.
      }
    }
    return out;
  }

  async list(now: Date = new Date()): Promise<BackupsView> {
    return withSpan(TRACER_NAME, 'backups.list', {}, async () => {
      const manifests = await this.manifests();
      const newest = newestComplete(manifests);
      const sets = [...manifests]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, BACKUP.listLimit)
        .map((m) => ({
          name: m.name,
          status: m.status,
          createdAt: m.createdAt,
          completedAt: m.completedAt,
          postgresBytes: m.postgres?.bytes ?? null,
          clickhouseBytes: m.clickhouse?.bytes ?? null,
          migration: m.postgres?.migration ?? null,
          cis: m.postgres?.cis ?? null,
          error: m.error,
        }));
      return {
        configured: this.env.BACKUP_DIR !== undefined,
        stale: backupsStale(manifests, now),
        staleAfterHours: BACKUP.staleHours,
        lastCompleteAt: newest?.completedAt ?? null,
        sets,
      };
    });
  }
}
