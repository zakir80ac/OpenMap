// REQ-SEC-004 REQ-DISC-031 — Node PKI: sign enrolment CSRs with the internal CA, fingerprint
// certificates, and bootstrap a CA for a fresh single-node deployment. WebCrypto plus @peculiar/x509.
const webcrypto = globalThis.crypto;
import * as x509 from '@peculiar/x509';
import { PKI, TIME } from '@openmap/constants';

x509.cryptoProvider.set(webcrypto);

const SIGNING = { name: 'ECDSA', hash: PKI.hash } as const;
const KEY_ALG = { name: 'ECDSA', namedCurve: PKI.curve } as const;

export interface IssuedCertificate {
  certificatePem: string;
  serialHex: string;
  fingerprintSha256: string;
  notAfter: Date;
}

export interface Ca {
  certificate: x509.X509Certificate;
  privateKey: CryptoKey;
}

function randomSerial(): string {
  const bytes = webcrypto.getRandomValues(new Uint8Array(PKI.serialBytes));
  // Clear the sign bit so the DER integer stays positive.
  bytes[0] = (bytes[0] ?? 0) >> 1;
  return Buffer.from(bytes).toString('hex');
}

function validityEnd(from: Date, days: number): Date {
  return new Date(from.getTime() + days * TIME.msPerDay);
}

export async function loadCa(certPem: string, keyPem: string): Promise<Ca> {
  const certificate = new x509.X509Certificate(certPem);
  const der = x509.PemConverter.decode(keyPem)[0];
  if (!der) throw new Error('CA key PEM contains no key');
  const privateKey = await webcrypto.subtle.importKey('pkcs8', der, KEY_ALG, true, ['sign']);
  return { certificate, privateKey };
}

/** Creates a self-signed CA valid for `days`; used by `scheduler pki init` and by tests. */
export async function generateCa(commonName: string, days: number): Promise<{ certPem: string; keyPem: string }> {
  const keys = await webcrypto.subtle.generateKey(KEY_ALG, true, ['sign', 'verify']);
  const notBefore = new Date();
  const notAfter = validityEnd(notBefore, days);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: 'CN=' + commonName + ', O=OpenMap',
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  return { certPem: cert.toString('pem'), keyPem: x509.PemConverter.encode(pkcs8, 'PRIVATE KEY') };
}

export async function fingerprintSha256(certPem: string): Promise<string> {
  const cert = new x509.X509Certificate(certPem);
  const digest = await cert.getThumbprint('SHA-256');
  return Buffer.from(digest).toString('hex');
}

/**
 * Signs a Node CSR. The subject CN must equal the node id and the OU the site code. The certificate carries
 * clientAuth (the scheduler requires it on mTLS routes) and serverAuth with a DNS SAN of the node id, because the
 * Node also serves it to host agents on its gateway (REQ-DISC-004) and agents verify the name they connect to.
 */
export async function signNodeCsr(ca: Ca, csrPem: string, nodeId: string, siteCode: string, days: number): Promise<IssuedCertificate> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const cn = csr.subjectName.getField('CN')[0];
  const ou = csr.subjectName.getField('OU')[0];
  if (cn !== nodeId) throw new Error('CSR common name ' + String(cn) + ' does not match node ' + nodeId);
  if (ou !== siteCode) throw new Error('CSR organizational unit ' + String(ou) + ' does not match site ' + siteCode);
  return issue(ca, csr, csr.subjectName, nodeId, [x509.ExtendedKeyUsage.clientAuth, x509.ExtendedKeyUsage.serverAuth], days);
}

/**
 * Signs a host agent CSR (REQ-DISC-004). Agents know their id but not their site, so the CSR must name the agent in
 * CN and the subject is rebuilt here as CN=agent, OU=site of the Node it enrols through. clientAuth only: agents
 * never serve.
 */
export async function signAgentCsr(ca: Ca, csrPem: string, agentId: string, siteCode: string, days: number): Promise<IssuedCertificate> {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  const cn = csr.subjectName.getField('CN')[0];
  if (cn !== agentId) throw new Error('CSR common name ' + String(cn) + ' does not match agent ' + agentId);
  const subject = new x509.Name([{ CN: [agentId] }, { OU: [siteCode] }]);
  return issue(ca, csr, subject, agentId, [x509.ExtendedKeyUsage.clientAuth], days);
}

async function issue(ca: Ca, csr: x509.Pkcs10CertificateRequest, subject: x509.Name, dnsName: string, usages: x509.ExtendedKeyUsage[], days: number): Promise<IssuedCertificate> {
  if (!(await csr.verify())) throw new Error('CSR signature is invalid');
  const notBefore = new Date();
  const notAfter = validityEnd(notBefore, days);
  const serialHex = randomSerial();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serialHex,
    subject,
    issuer: ca.certificate.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGNING,
    publicKey: csr.publicKey,
    signingKey: ca.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension(usages),
      new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: dnsName }]),
      await x509.AuthorityKeyIdentifierExtension.create(ca.certificate),
      await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
    ],
  });
  const certificatePem = cert.toString('pem');
  return { certificatePem, serialHex, fingerprintSha256: await fingerprintSha256(certificatePem), notAfter };
}

/** Verifies that a client certificate chains to the CA and names the given node. */
export async function verifyNodeCertificate(ca: Ca, certPem: string, nodeId: string): Promise<boolean> {
  const cert = new x509.X509Certificate(certPem);
  if (cert.subjectName.getField('CN')[0] !== nodeId) return false;
  if (cert.notAfter.getTime() < Date.now()) return false;
  return cert.verify({ publicKey: await ca.certificate.publicKey.export(), signatureOnly: true });
}
