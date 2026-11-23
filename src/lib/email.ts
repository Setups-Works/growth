import nodemailer from "nodemailer";

/**
 * Outgoing email — currently only password-reset links.
 *
 * Any SMTP server works (Gmail with an app password, Azure Communication
 * Services, Brevo, Mailgun…). Without SMTP_HOST the message is written to the
 * server log instead, so a self-hosted install still works: the operator
 * reads the reset link from `docker compose logs app`.
 */

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!emailConfigured()) {
    console.log(`[email] SMTP_HOST not set — would send to ${to}:\n  Subject: ${subject}\n  ${text.replace(/\n/g, "\n  ")}`);
    return;
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to,
    subject,
    text,
  });
}
