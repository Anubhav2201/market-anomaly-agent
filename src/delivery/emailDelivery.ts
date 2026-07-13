import nodemailer, { Transporter } from "nodemailer";

/**
 * Sends alert emails via SMTP. Defaults to Gmail's SMTP relay
 * specifically because it requires ZERO new third-party signup - an
 * "App Password" from an existing Gmail account (myaccount.google.com
 * -> Security -> 2-Step Verification -> App Passwords) is genuinely
 * free with no daily-volume concerns at this project's actual scale
 * (Gmail's own sending limit is ~500/day for a personal account, far
 * beyond a solo-testing subscriber list).
 *
 * NOT recommended beyond solo/testing scale - sending transactional
 * mail from a personal Gmail account has real deliverability/spam
 * risk once you have many real recipients, and Gmail's SMTP relay
 * isn't designed for that use case. A dedicated transactional email
 * provider (SendGrid, Resend, SES) is the right call before this ever
 * has real subscribers beyond you testing it - see DECISIONS.md
 * ADR-026 for the explicit tradeoff.
 *
 * Configured via generic SMTP env vars (not Gmail-specific names) so
 * swapping providers later is a config change, not a code change:
 *   SMTP_HOST (default smtp.gmail.com)
 *   SMTP_PORT (default 465)
 *   SMTP_USER - the sending account's email address
 *   SMTP_PASS - an App Password (Gmail) or API key (other providers)
 *   ALERT_FROM_EMAIL (defaults to SMTP_USER)
 *
 * Degrades gracefully (logs, doesn't throw) if unconfigured - same
 * philosophy as every other optional external dependency in this
 * project (missing GROQ_API_KEY, missing ADANOS_API_KEY, etc.).
 * fanout-svc should keep working (and logging what it WOULD have sent)
 * even before email is set up.
 */
export class EmailDelivery {
  private transporter: Transporter | null;
  private fromAddress: string;

  constructor() {
    const host = process.env.SMTP_HOST ?? "smtp.gmail.com";
    const port = Number(process.env.SMTP_PORT ?? 465);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    this.fromAddress = process.env.ALERT_FROM_EMAIL ?? user ?? "";

    if (!user || !pass) {
      console.warn(
        "[emailDelivery] SMTP_USER/SMTP_PASS not set - email delivery disabled, will log instead"
      );
      this.transporter = null;
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // true for 465 (implicit TLS), false for 587 (STARTTLS)
      auth: { user, pass },
    });
  }

  /**
   * Sends one alert email to one recipient. Returns true if actually
   * sent, false if delivery is unconfigured or failed - callers should
   * treat false as "log it instead," not throw, since a delivery
   * failure shouldn't crash fanout-svc or block processing the next
   * alert.
   */
  async send(to: string, subject: string, body: string): Promise<boolean> {
    if (!this.transporter) return false;

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        text: body,
      });
      return true;
    } catch (err) {
      console.error(`[emailDelivery] send failed to ${to}:`, err);
      return false;
    }
  }
}
