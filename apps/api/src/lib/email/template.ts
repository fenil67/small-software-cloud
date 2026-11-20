/**
 * Email template builder for app-access invites.
 *
 * buildInviteEmail({ granterName, granterEmail, appName, appUrl })
 *   → { subject, html, text }
 *
 * All user-supplied values are HTML-escaped. Subject has CR/LF stripped and
 * is capped at 120 characters. App URL is only included when non-null.
 */

export interface InviteEmailParams {
  /** display_name ?? email of the granter; never null/undefined — caller guarantees */
  granterName: string;
  /** Email of the granter; used as reply-to label */
  granterEmail: string;
  /** Name of the app being shared */
  appName: string;
  /** Full HTTPS URL of the app, or null if not yet deployed */
  appUrl: string | null;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeSubject(s: string): string {
  // Strip CR, LF, and ASCII control characters; cap at 120 chars
  return s.replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 120);
}

export function buildInviteEmail(params: InviteEmailParams): BuiltEmail {
  const { granterName, granterEmail, appName, appUrl } = params;

  const subject = sanitizeSubject(`${granterName} shared ${appName} with you`);

  const eName = escapeHtml(granterName);
  const eEmail = escapeHtml(granterEmail);
  const eApp = escapeHtml(appName);
  const eUrl = appUrl ? escapeHtml(appUrl) : null;

  const buttonHtml = eUrl
    ? `
    <tr>
      <td align="center" style="padding:24px 0 0;">
        <a href="${eUrl}"
           target="_blank"
           rel="noopener noreferrer"
           style="display:inline-block;padding:12px 28px;background:#0d0d0d;color:#ffffff;
                  font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;
                  text-decoration:none;border-radius:8px;">
          Open ${eApp}
        </a>
      </td>
    </tr>`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:system-ui,-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
         style="background:#f5f5f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation"
               style="background:#ffffff;border-radius:16px;overflow:hidden;
                      border:1px solid #e5e5e5;max-width:560px;width:100%;">
          <!-- Logo header -->
          <tr>
            <td style="padding:28px 32px 20px;border-bottom:1px solid #f0f0f0;">
              <img src="https://app.utir.dev/brand/utir-email-logo.png"
                   width="81" height="32" alt="Utir"
                   style="display:block;" />
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 8px;">
              <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#0d0d0d;line-height:1.4;">
                ${eName} shared an app with you
              </p>
              <p style="margin:0 0 8px;font-size:14px;color:#555;line-height:1.6;">
                <strong style="color:#0d0d0d;">${eName}</strong>
                (${eEmail}) gave you access to
                <strong style="color:#0d0d0d;">${eApp}</strong>.
              </p>
              ${eUrl
                ? `<p style="margin:0;font-size:13px;color:#888;line-height:1.5;word-break:break-all;">
                     ${eUrl}
                   </p>`
                : `<p style="margin:0;font-size:13px;color:#888;line-height:1.5;">
                     The app is not yet deployed. Check back later.
                   </p>`
              }
            </td>
          </tr>
          ${buttonHtml}
          <!-- Footer -->
          <tr>
            <td style="padding:32px 32px 28px;border-top:1px solid #f0f0f0;margin-top:24px;">
              <p style="margin:0;font-size:12px;color:#aaa;line-height:1.6;">
                You received this because ${eName} (${eEmail}) shared an app with you on Utir.
                If you did not expect this email, you can safely ignore it.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textButton = eUrl ? `\nOpen ${appName}: ${appUrl}\n` : "\nThe app is not yet deployed.\n";

  const text = [
    `${granterName} shared ${appName} with you`,
    "",
    `${granterName} (${granterEmail}) gave you access to "${appName}".`,
    textButton,
    "---",
    `You received this because ${granterName} (${granterEmail}) shared an app with you on Utir.`,
    "If you did not expect this email, you can safely ignore it.",
  ].join("\n");

  return { subject, html, text };
}
