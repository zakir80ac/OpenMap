// REQ-INT-009 (ADR-065) — a small SMTP client for email notifications: implicit TLS (smtps://) or STARTTLS (smtp://),
// AUTH PLAIN when the credential carries a user, one message in multipart/alternative (text and HTML, UTF-8, base64)
// to every recipient. RFC 5321 replies are read line by line, multi-line replies included; every reply has a timeout.
// Kept in the engine rather than adding a mail library: the engine sends a handful of messages and needs nothing more.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { NOTIFICATION } from '@openmap/constants';

export interface SmtpTarget {
  host: string;
  port: number;
  /** TLS from the first byte (smtps://). */
  secure: boolean;
  /** Upgrade a plain connection with STARTTLS when the server offers it. */
  startTls: boolean;
  username: string | null;
  password: string | null;
}

export interface MailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface SmtpResult {
  /** The reply code to the end of DATA (250 when accepted). */
  code: number;
  response: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const SMTPS_SCHEME = 'smtps:';
const SMTP_SCHEME = 'smtp:';
const CRLF = '\r\n';
const BASE64_LINE = NOTIFICATION.base64LineLength;
const REPLY_CODE_LENGTH = NOTIFICATION.smtpReplyCodeLength;
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/u;

/** The SMTP server an `smtp://` or `smtps://` endpoint names. */
export function smtpTargetFrom(
  endpoint: string,
  startTls: boolean,
  fields: Readonly<Record<string, string>>,
): SmtpTarget {
  const url = new URL(endpoint);
  if (url.protocol !== SMTP_SCHEME && url.protocol !== SMTPS_SCHEME)
    throw new SmtpError('endpoint must be smtp:// or smtps://', null);
  const secure = url.protocol === SMTPS_SCHEME;
  return {
    host: url.hostname,
    port:
      url.port === ''
        ? secure
          ? NOTIFICATION.smtpsDefaultPort
          : NOTIFICATION.smtpDefaultPort
        : Number(url.port),
    secure,
    startTls,
    username: fields['username'] ?? null,
    password: fields['password'] ?? null,
  };
}

function encodeHeader(text: string): string {
  return ASCII_PRINTABLE.test(text)
    ? text
    : '=?UTF-8?B?' + Buffer.from(text, 'utf8').toString('base64') + '?=';
}

function base64Lines(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += BASE64_LINE) lines.push(b64.slice(i, i + BASE64_LINE));
  return lines.join(CRLF);
}

/** The RFC 5322 message, CRLF line ends, dot-stuffed for DATA. */
export function mimeMessage(mail: MailMessage, now: Date): string {
  const boundary = 'openmap-' + randomUUID();
  const lines = [
    'From: ' + mail.from,
    'To: ' + mail.to.join(', '),
    'Subject: ' + encodeHeader(mail.subject),
    'Date: ' + now.toUTCString(),
    'Message-ID: <' + randomUUID() + '@openmap>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    '--' + boundary,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html),
    '--' + boundary + '--',
  ];
  return lines.map((l) => (l.startsWith('.') ? '.' + l : l)).join(CRLF);
}

/** Reads SMTP replies from a socket: one promise per reply, multi-line replies joined. */
class ReplyReader {
  private buffer = '';
  private lines: string[] = [];
  private waiting: Array<{
    resolve: (r: { code: number; text: string }) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private failure: Error | null = null;

  constructor(private socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  attach(socket: Socket | TLSSocket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let at = this.buffer.indexOf(CRLF);
      while (at >= 0) {
        this.lines.push(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + CRLF.length);
        at = this.buffer.indexOf(CRLF);
      }
      this.drain();
    });
    socket.on('error', (err: Error) => {
      this.fail(err);
    });
    socket.on('close', () => {
      this.fail(new SmtpError('connection closed', null));
    });
  }

  /** Detaches from the plain socket before a STARTTLS upgrade so its events do not race the TLS socket's. */
  detach(): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  private fail(err: Error): void {
    this.failure ??= err;
    for (const w of this.waiting.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const end = this.lines.findIndex(
        (l) => l.length <= REPLY_CODE_LENGTH || l.charAt(REPLY_CODE_LENGTH) !== '-',
      );
      if (end < 0) return;
      const reply = this.lines.splice(0, end + 1);
      const last = reply[reply.length - 1] ?? '';
      const w = this.waiting.shift();
      if (w === undefined) return;
      clearTimeout(w.timer);
      w.resolve({
        code: Number(last.slice(0, REPLY_CODE_LENGTH)),
        text: reply.map((l) => l.slice(REPLY_CODE_LENGTH + 1)).join('\n'),
      });
    }
  }

  next(timeoutMs: number): Promise<{ code: number; text: string }> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w.timer !== timer);
        reject(new SmtpError('timed out waiting for the server', null));
      }, timeoutMs);
      this.waiting.push({ resolve, reject, timer });
      this.drain();
    });
  }
}

function open(target: SmtpTarget): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = target.secure
      ? tlsConnect({ host: target.host, port: target.port, servername: target.host }, () => {
          resolve(socket);
        })
      : netConnect({ host: target.host, port: target.port }, () => {
          resolve(socket);
        });
    socket.once('error', reject);
  });
}

function upgrade(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket, servername: host }, () => {
      resolve(tls);
    });
    tls.once('error', reject);
  });
}

/** Sends one message; resolves with the server's acceptance, rejects with an SmtpError naming the refused step. */
export async function sendMail(
  target: SmtpTarget,
  mail: MailMessage,
  timeoutMs: number = NOTIFICATION.smtpTimeoutMs,
  now: Date = new Date(),
): Promise<SmtpResult> {
  const codes = NOTIFICATION.smtpCodes;
  let socket = await open(target);
  const reader = new ReplyReader(socket);
  const write = (line: string): void => {
    socket.write(line + CRLF);
  };
  const expect = async (step: string, ...accepted: number[]): Promise<{ code: number; text: string }> => {
    const r = await reader.next(timeoutMs);
    if (!accepted.includes(r.code))
      throw new SmtpError(step + ' refused: ' + String(r.code) + ' ' + r.text, r.code);
    return r;
  };
  try {
    await expect('greeting', codes.ready);
    write('EHLO ' + hostname());
    const ehlo = await expect('EHLO', codes.ok);
    if (!target.secure && target.startTls && /\bSTARTTLS\b/iu.test(ehlo.text)) {
      write('STARTTLS');
      await expect('STARTTLS', codes.ready);
      reader.detach();
      socket = await upgrade(socket, target.host);
      reader.attach(socket);
      write('EHLO ' + hostname());
      await expect('EHLO', codes.ok);
    }
    if (target.username !== null && target.password !== null) {
      write(
        'AUTH PLAIN ' +
          Buffer.from('\0' + target.username + '\0' + target.password, 'utf8').toString('base64'),
      );
      await expect('AUTH', codes.authenticated);
    }
    write('MAIL FROM:<' + mail.from + '>');
    await expect('MAIL FROM', codes.ok);
    for (const rcpt of mail.to) {
      write('RCPT TO:<' + rcpt + '>');
      await expect('RCPT TO ' + rcpt, codes.ok, codes.forwarded);
    }
    write('DATA');
    await expect('DATA', codes.startData);
    socket.write(mimeMessage(mail, now) + CRLF + '.' + CRLF);
    const accepted = await expect('message', codes.ok);
    write('QUIT');
    await reader.next(timeoutMs).catch(() => ({ code: codes.closing, text: '' }));
    return { code: accepted.code, response: accepted.text };
  } finally {
    socket.destroy();
  }
}
