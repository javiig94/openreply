/**
 * Tiempos de respuesta. Son valores de partida, sin medir: se ajustan cuando
 * haya conversaciones reales.
 */

const MIN_WAIT_MS = 30_000;
const MAX_WAIT_MS = 90_000;

/**
 * Espera antes de contestar: de 30 a 90 s, algo mas si el mensaje es largo.
 * Sirve tambien para juntar varios mensajes seguidos en una sola respuesta.
 */
export function replyDelayMs(
  userText: string,
  random: () => number = Math.random
): number {
  const reading = Math.min(30_000, userText.length * 150);
  const jitter = random() * 30_000;
  return Math.round(Math.min(MAX_WAIT_MS, MIN_WAIT_MS + reading + jitter));
}

/** Tiempo con "escribiendo..." segun lo largo que sea el mensaje. */
export function typingMs(
  replyText: string,
  random: () => number = Math.random
): number {
  return Math.round(
    Math.min(8_000, 1_500 + replyText.length * 30 + random() * 1_000)
  );
}

const REMINDER_AFTER_HOURS = 20;
const REMINDER_LATEST_HOURS = 23.5;
const REMINDER_EARLIEST_HOURS = 12;
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL_HOUR = 9;

function madridHour(date: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hour) % 24;
}

function isQuietHour(date: Date): boolean {
  const hour = madridHour(date);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/**
 * Cuando enviar el unico recordatorio: dentro de las 24 h que permite Meta y sin
 * despertar a nadie. Primero busca hacia delante desde las 20 h y, si cae de
 * noche, hacia atras hasta las 12 h. Devuelve null si no hay hueco valido.
 */
export function reminderTime(lastUserMessageAt: Date): Date | null {
  const hours = (value: number) =>
    new Date(lastUserMessageAt.getTime() + value * 3_600_000);

  for (
    let offset = REMINDER_AFTER_HOURS;
    offset <= REMINDER_LATEST_HOURS;
    offset += 0.5
  ) {
    if (!isQuietHour(hours(offset))) return hours(offset);
  }
  for (
    let offset = REMINDER_AFTER_HOURS - 0.5;
    offset >= REMINDER_EARLIEST_HOURS;
    offset -= 0.5
  ) {
    if (!isQuietHour(hours(offset))) return hours(offset);
  }
  return null;
}

/** Margen de seguridad: pasada esta edad ya no se escribe, aunque falten minutos. */
export const MESSAGING_WINDOW_MS = 23.75 * 3_600_000;
