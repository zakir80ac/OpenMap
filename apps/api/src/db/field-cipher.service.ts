// REQ-SEC-011 (ADR-067 step 4) — the API's field encryption: the personal data that must stay protected from anyone
// who can query the database and in `pg_dump` output (vendor contacts, asset custodians, custom fields marked
// sensitive) is stored as OpenBao Transit ciphertext and decrypted only on the way out of the API. The key never leaves
// OpenBao. Without OpenBao a write fails rather than storing plaintext.
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { withSpan } from '@openmap/telemetry';
import { createFieldCipher, createVaultTokenProvider, VaultUnavailableError, type FieldCipher } from '@openmap/vault';
import { ENV, type Env } from '../config/env.module.js';
import { MetricsService } from '../metrics/metrics.service.js';

const TRACER_NAME = 'openmap-api';

@Injectable()
export class FieldCipherService {
  /** Replaceable for tests; the global fetch in production. */
  fetchImpl: typeof fetch = fetch;

  private readonly cipher: FieldCipher;

  constructor(
    @Inject(ENV) env: Env,
    private readonly metrics: MetricsService,
  ) {
    const fetchVia: typeof fetch = (input, init) => this.fetchImpl(input, init);
    this.cipher = createFieldCipher(env, createVaultTokenProvider(env, fetchVia), fetchVia);
  }

  encrypt(values: readonly (string | null)[]): Promise<(string | null)[]> {
    return this.run('encrypt', values, () => this.cipher.encrypt(values));
  }

  decrypt(values: readonly (string | null)[]): Promise<(string | null)[]> {
    return this.run('decrypt', values, () => this.cipher.decrypt(values));
  }

  /** One value, for the single-field cases. */
  async encryptOne(value: string | null): Promise<string | null> {
    return (await this.encrypt([value]))[0] ?? null;
  }

  async decryptOne(value: string | null): Promise<string | null> {
    return (await this.decrypt([value]))[0] ?? null;
  }

  private async run(
    op: 'encrypt' | 'decrypt',
    values: readonly (string | null)[],
    work: () => Promise<(string | null)[]>,
  ): Promise<(string | null)[]> {
    const count = values.filter((v) => v !== null).length;
    if (count === 0) return [...values];
    try {
      const out = await withSpan(TRACER_NAME, 'field_cipher.' + op, { 'openmap.values': count }, work);
      this.metrics.fieldCipher.inc({ op, outcome: 'ok' }, count);
      return out;
    } catch (err) {
      this.metrics.fieldCipher.inc({ op, outcome: 'error' }, count);
      if (err instanceof VaultUnavailableError) throw new ServiceUnavailableException('field encryption unavailable: ' + err.message);
      throw err;
    }
  }
}
