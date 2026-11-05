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

export async function notifyHandoff({
  to,
  username,
  reason,
}: {
  to: string | null;
  username: string | null;
  reason: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const baseUrl = process.env.NEXTAUTH_URL ?? "";
  if (!to || !apiKey || !from) return;

  const who = username ? `@${username}` : "Una persona";
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
        subject: `${who} necesita que le conteste una persona`,
        html: `<p>${escapeHtml(who)} necesita que le conteste una persona en Instagram.</p><p>Motivo: ${escapeHtml(reason)}</p><p><a href="${escapeHtml(baseUrl)}/assistant">Ver la conversación</a></p>`,
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
