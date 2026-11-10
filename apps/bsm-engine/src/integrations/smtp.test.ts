// T-563 REQ-INT-009 (ADR-065) — the SMTP client against an in-test SMTP server speaking RFC 5321: multi-line EHLO,
// AUTH PLAIN, MAIL, RCPT, DATA with the dot-terminated message, QUIT; the message is multipart text and HTML in UTF-8
// base64 with an encoded Arabic subject; a refused recipient and an unanswered greeting end in an SmtpError.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpError, mimeMessage, sendMail, smtpTargetFrom, type SmtpTarget } from './smtp.js';

interface Session {
  commands: string[];
  data: string;
}

function smtpServer(
  options: { refuseRcpt?: string; silent?: boolean } = {},
): Promise<{ server: Server; port: number; sessions: Session[] }> {
  const sessions: Session[] = [];
  const server = createServer((socket: Socket) => {
    const session: Session = { commands: [], data: '' };
    sessions.push(session);
    if (options.silent === true) return;
    let buffer = '';
    let inData = false;
    socket.setEncoding('utf8');
    socket.write('220 lab.test ESMTP ready\r\n');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 queued as 42\r\n');
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        session.commands.push(line);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO')
          socket.write('250-lab.test greets you\r\n250-SIZE 10240000\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 authenticated\r\n');
        else if (verb === 'MAIL') socket.write('250 2.1.0 ok\r\n');
        else if (verb === 'RCPT')
          socket.write(
            options.refuseRcpt !== undefined && line.includes(options.refuseRcpt)
              ? '550 5.1.1 no such user\r\n'
              : '250 2.1.5 ok\r\n',
          );
        else if (verb === 'DATA') {
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
          inData = true;
        } else if (verb === 'QUIT') {
          socket.end('221 2.0.0 bye\r\n');
          return;
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, sessions });
    });
  });
}

let open: Server | null = null;
afterEach(async () => {
  if (open !== null)
    await new Promise<void>((r) =>
      open?.close(() => {
        r();
      }),
    );
  open = null;
});

const target = (port: number): SmtpTarget => ({
  host: '127.0.0.1',
  port,
  secure: false,
  startTls: true,
  username: 'alerts',
  password: 'pw',
});
const mail = {
  from: 'openmap@lab.test',
  to: ['noc@lab.test', 'oncall@lab.test'],
  subject: 'تحذير: SLA',
  text: 'line one\r\n.starts with a dot',
  html: '<p>hi</p>',
};

describe('SMTP client', () => {
  it('authenticates, sends to every recipient and is accepted', async () => {
    const s = await smtpServer();
    open = s.server;
    const result = await sendMail(target(s.port), mail, 2_000, new Date('2026-11-10T12:00:00Z'));
    expect(result).toEqual({ code: 250, response: '2.0.0 queued as 42' });
    const session = s.sessions[0];
    expect(session?.commands.map((c) => c.split(' ')[0])).toEqual([
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'RCPT',
      'DATA',
      'QUIT',
    ]);
    expect(session?.commands[1]).toBe('AUTH PLAIN ' + Buffer.from('\0alerts\0pw').toString('base64'));
    expect(session?.commands[3]).toBe('RCPT TO:<noc@lab.test>');
    const data = session?.data ?? '';
    expect(data).toContain('Subject: =?UTF-8?B?' + Buffer.from('تحذير: SLA').toString('base64') + '?=');
    expect(data).toContain('Content-Type: multipart/alternative');
    const parts = [...data.matchAll(/base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/gu)].map((m) =>
      Buffer.from((m[1] ?? '').replace(/\r\n/gu, ''), 'base64').toString('utf8'),
    );
    expect(parts).toEqual([mail.text, mail.html]);
  });

  it('never sends a line that would end DATA early, whatever the text holds', () => {
    const lines = mimeMessage({ ...mail, text: '.\r\n.\r\n..', html: '.' }, new Date(0)).split('\r\n');
    expect(lines).not.toContain('.');
    expect(lines.filter((l) => l.startsWith('.') && !l.startsWith('..'))).toEqual([]);
  });

  it('names the refused step and its code, and gives up on a silent server', async () => {
    const s = await smtpServer({ refuseRcpt: 'oncall' });
    open = s.server;
    await expect(sendMail(target(s.port), mail, 2_000)).rejects.toMatchObject({
      code: 550,
      message: expect.stringContaining('RCPT TO oncall@lab.test refused') as unknown as string,
    });
    await new Promise<void>((r) =>
      s.server.close(() => {
        r();
      }),
    );
    const silent = await smtpServer({ silent: true });
    open = silent.server;
    await expect(sendMail(target(silent.port), mail, 200)).rejects.toBeInstanceOf(SmtpError);
  });

  it('reads the server from an smtp:// or smtps:// endpoint', () => {
    expect(smtpTargetFrom('smtps://mail.lab.test', true, {})).toMatchObject({
      host: 'mail.lab.test',
      port: 465,
      secure: true,
      username: null,
    });
    expect(
      smtpTargetFrom('smtp://mail.lab.test:2525', false, { username: 'u', password: 'p' }),
    ).toMatchObject({ port: 2525, secure: false, startTls: false, username: 'u' });
    expect(() => smtpTargetFrom('https://mail.lab.test', true, {})).toThrow(SmtpError);
  });
});
