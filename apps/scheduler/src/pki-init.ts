// REQ-SEC-004 — one-shot bootstrap: writes a CA and a scheduler TLS certificate to the configured
// paths when none exist. Idempotent; never overwrites existing material.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const webcrypto = globalThis.crypto;
import * as x509 from '@peculiar/x509';
import { loadEnv } from '@openmap/config';
import { PKI, TIME } from '@openmap/constants';
import { generateCa, loadCa } from './server/pki.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!existsSync(env.SCHEDULER_CA_CERT_PATH)) {
    const ca = await generateCa('OpenMap Discovery CA', PKI.caValidityDays);
    for (const p of [env.SCHEDULER_CA_CERT_PATH, env.SCHEDULER_CA_KEY_PATH]) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(env.SCHEDULER_CA_CERT_PATH, ca.certPem);
    writeFileSync(env.SCHEDULER_CA_KEY_PATH, ca.keyPem, { mode: 0o600 });
    console.log('pki: CA written to ' + env.SCHEDULER_CA_CERT_PATH);
  }
  if (!existsSync(env.SCHEDULER_TLS_CERT_PATH)) {
    const ca = await loadCa(readFileSync(env.SCHEDULER_CA_CERT_PATH, 'utf8'), readFileSync(env.SCHEDULER_CA_KEY_PATH, 'utf8'));
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: PKI.curve }, true, ['sign', 'verify']);
    const host = new URL(env.PUBLIC_SCHEDULER_URL).hostname;
    const sans = [host, ...env.SCHEDULER_TLS_EXTRA_SANS.split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s !== host)];
    const notBefore = new Date();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(PKI.serialBytes))).toString('hex'),
      subject: 'CN=' + host + ', O=OpenMap',
      issuer: ca.certificate.subject,
      notBefore,
      notAfter: new Date(notBefore.getTime() + PKI.serverValidityDays * TIME.msPerDay),
      signingAlgorithm: { name: 'ECDSA', hash: PKI.hash },
      publicKey: keys.publicKey,
      signingKey: ca.privateKey,
      extensions: [
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(sans.map((value) => ({ type: 'dns' as const, value }))),
      ],
    });
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    for (const p of [env.SCHEDULER_TLS_CERT_PATH, env.SCHEDULER_TLS_KEY_PATH]) mkdirSync(dirname(p), { recursive: true });
    writeFileSync(env.SCHEDULER_TLS_CERT_PATH, cert.toString('pem'));
    writeFileSync(env.SCHEDULER_TLS_KEY_PATH, x509.PemConverter.encode(pkcs8, 'PRIVATE KEY'), { mode: 0o600 });
    console.log('pki: scheduler certificate written for ' + host);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
