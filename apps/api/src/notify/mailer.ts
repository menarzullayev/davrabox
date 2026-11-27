import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  readonly enabled: boolean;
  send(m: Mail): Promise<void>;
}

/** Plain-text mail through the configured relay; a disabled mailer (no SMTP_HOST) sends nothing. */
export function createMailer(cfg: Config): Mailer {
  if (!cfg.SMTP_HOST) return { enabled: false, send: async () => undefined };
  const port = cfg.SMTP_PORT;
  const transport = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    ...(cfg.SMTP_USER ? { auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASSWORD ?? '' } } : {}),
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    enabled: true,
    send: async (m) => {
      await transport.sendMail({ from: { name: cfg.SMTP_FROM_NAME, address: cfg.SMTP_FROM }, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
