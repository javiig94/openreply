/**
 * Avisa por correo cuando una conversacion necesita a una persona. Solo lleva el
 * usuario y el motivo: el contenido se lee en el panel. Si falla, no rompe nada.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Correo a Javi con un enlace a su panel. Si falla, no rompe nada. */
export async function sendOwnerEmail({
  to,
  subject,
  text,
  linkPath,
}: {
  to: string | null;
  subject: string;
  text: string;
  linkPath: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const baseUrl = process.env.NEXTAUTH_URL ?? "";
  if (!to || !apiKey || !from) return;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to,
        subject,
        html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(baseUrl)}${escapeHtml(linkPath)}">Abrir el panel</a></p>`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`[Assistant] Aviso por correo: error ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.name : "desconocido";
    console.error(`[Assistant] Aviso por correo: ${message}`);
  }
}

export async function notifyHandoff({
  to,
  username,
  reason,
}: {
  to: string | null;
  username: string | null;
  reason: string;
}): Promise<void> {
  const who = username ? `@${username}` : "Una persona";
  await sendOwnerEmail({
    to,
    subject: `${who} necesita que le conteste una persona`,
    text: `${who} necesita que le conteste una persona en Instagram. Motivo: ${reason}`,
    linkPath: "/assistant",
  });
}
