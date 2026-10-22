// T-021 REQ-SEC-004
import { webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { describe, expect, it } from 'vitest';
import { generateCa, loadCa, signNodeCsr, verifyNodeCertificate } from './pki.js';

async function csrFor(cn: string, ou: string): Promise<string> {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: 'CN=' + cn + ', OU=' + ou, keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } });
  return csr.toString('pem');
}

describe('node pki', () => {
  it('signs a matching CSR and the certificate verifies against the CA', async () => {
    const caPems = await generateCa('OpenMap test CA', 1);
    const ca = await loadCa(caPems.certPem, caPems.keyPem);
    const issued = await signNodeCsr(ca, await csrFor('node-ryd-01', 'RYD'), 'node-ryd-01', 'RYD', 1);
    expect(issued.fingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyNodeCertificate(ca, issued.certificatePem, 'node-ryd-01')).toBe(true);
    expect(await verifyNodeCertificate(ca, issued.certificatePem, 'node-other')).toBe(false);
  });
  it('rejects a CSR whose subject does not match the enrolment', async () => {
    const caPems = await generateCa('OpenMap test CA', 1);
    const ca = await loadCa(caPems.certPem, caPems.keyPem);
    await expect(signNodeCsr(ca, await csrFor('node-x', 'RYD'), 'node-ryd-01', 'RYD', 1)).rejects.toThrow(/common name/);
    await expect(signNodeCsr(ca, await csrFor('node-ryd-01', 'JED'), 'node-ryd-01', 'RYD', 1)).rejects.toThrow(/organizational unit/);
  });
});
