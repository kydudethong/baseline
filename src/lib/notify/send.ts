/**
 * Send one email through Resend. Best-effort, always.
 *
 * Resend because it is one API key and one HTTPS call -- no SDK, no SMTP
 * relay, nothing to keep alive -- which is the right weight for one kind of
 * message. Swapping providers is this file and nothing else.
 *
 * NEVER THROWS. An email that fails to send must not fail the analysis it is
 * about; the read is on the page either way. Returns whether it went, so the
 * caller can log it.
 */
import type { EmailContent } from "./read-email";

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail(to: string, content: EmailContent): Promise<boolean> {
  if (!emailConfigured()) {
    // Said, not silent. A feature whose only failure mode is "nothing
    // happened" cannot be debugged from outside -- which is exactly what the
    // idle-sleep watchdog taught this repo once already.
    console.warn("[email] not sent: RESEND_API_KEY and EMAIL_FROM are not both set");
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    });
    if (!res.ok) {
      console.warn(`[email] Resend refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[email] send failed: ${(err as Error).message}`);
    return false;
  }
}
