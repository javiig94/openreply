/**
 * Filtro mecanico de lo que propone la IA, antes de enviarlo.
 *
 * La IA recibe estas normas por escrito, pero no se confia en su palabra: nada
 * sale sin pasar por aqui. "hard" impide enviar el mensaje; "style" pide
 * reescribirlo una vez y, si vuelve a fallar, se envia igual.
 */

export type ViolationSeverity = "hard" | "style";

export interface Violation {
  code: string;
  severity: ViolationSeverity;
  detail: string;
}

export interface GuardrailContext {
  lastUserText: string;
  allowedDomains: string[];
  /** Importes que si se pueden decir, escritos solo con cifras: "39,99". */
  allowedAmounts?: string[];
  /** Ya salio el enlace de la web en esta conversacion. */
  alreadyInvited?: boolean;
}

const DEFAULT_ALLOWED_AMOUNTS = ["39,99", "39.99"];
const MAX_MESSAGE_CHARS = 500;
const STYLE_MESSAGE_CHARS = 280;
const MAX_MESSAGES = 2;

const CLAIMS_HUMAN: RegExp[] = [
  /\b(soy|somos)\s+(una?\s+)?(persona|personas|humano|humana|humanos|de verdad|de carne)\b/i,
  /\bno\s+soy\s+(un\s+|una\s+)?(bot|robot|ia|m[aá]quina|inteligencia artificial|asistente|programa)\b/i,
  /\bsoy\s+javi\b/i,
  /\bte\s+escribe\s+javi\b/i,
  // Una vida propia tambien es hacerse pasar por persona.
  /\b(que|lo|la)\s+uso\s+yo\b/i,
  /\byo\s+(uso|hago|hice|tengo|empec[eé]|gan[eé]|monet[ií]c[eé])(?![a-záéíóúñ])/i,
  /\ben\s+mi\s+(canal|caso|experiencia)\b/i,
  /\bmi\s+(canal|experiencia)\b/i,
  /\ba\s+m[ií]\s+me\s+(funcion|fue|sirvi)/i,
  /\blo\s+probar[eé](?![a-z])/i,
  /\bqu[eé]\s+(meme|v[ií]deo|foto)\s+m[aá]s\b/i,
];

// Promesas de cosas que el asistente no puede hacer.
const IMPOSSIBLE_PROMISES: RegExp[] = [
  /\bte\s+(aviso|avisar[eé]|apunto|apuntar[eé]|he\s+(apuntado|a[nñ]adido))(?![a-záéíóúñ])/i,
  /\bte\s+lo\s+guardo\b/i,
  /\bdime\s+tu\s+(e-?mail|correo)\b/i,
];

const INVENTED_FACTS: RegExp[] = [
  /\bpaypal\b/i,
  /\bdesde\s+el\s+primer\s+v[ií]deo\b/i,
  /\bgarant[ií]a\s+de\s+devoluci[oó]n\b/i,
  /\ben\s+\d+(\s*[-–a]\s*\d+)?\s+(d[ií]as|semanas|meses)\s+(podr[ií]as|puedes|llegas|llegar[aá]s|empiezan?)\b/i,
  /\bempiezan?\s+a\s+(ver\s+)?(ingresos|ganar|cobrar)\s+en\s+\d/i,
  /\b\d+(\s*[-–a]\s*\d+)?\s+meses\b.{0,30}\b(ingresos|ganar|cobrar|monetiz)/i,
];

// Valorar lo que la persona hace sin datos: el "buen tema" automatico.
const EMPTY_PRAISE =
  /\b(buen|gran)\s+tema\b|\bmucha\s+demanda\b|\bmucho\s+potencial\b|\bcon\s+futuro\b|\bya\s+(tienes\s+base|est[aá]s\s+cerca)\b/i;

// Nada de porcentajes: en lo que sabe el asistente no hay ninguno.
const PERCENTAGE = /\d[\d.,]*\s*%/;

const INCOME_PROMISES: RegExp[] = [
  /\b(vas|vais|van)\s+a\s+(ganar|cobrar|facturar|vivir\s+de)\b/i,
  /\bganar[aá]s\b/i,
  /\bseguro\s+que\s+(ganas|cobras|lo\s+consigues|monetizas)\b/i,
  /\bdinero\s+(f[aá]cil|r[aá]pido|seguro)\b/i,
  /\bsin\s+esfuerzo\b/i,
  /\bhazte\s+rico\b/i,
  /\bte\s+har[aá]s\s+rico\b/i,
  /\bingresos\s+(garantizados|asegurados|seguros)\b/i,
  /\ben\s+\d+\s+(d[ií]as|semanas|meses)\s+(est[aá]s|ganas|cobras|monetizas)\b/i,
];

const FALSE_SCARCITY: RegExp[] = [
  /[uú]ltimas?\s+plazas?\b/i,
  /\bquedan\s+(pocas|solo|s[oó]lo|\d+)\b/i,
  /\bsolo\s+hoy\b/i,
  /\bse\s+acaba\s+(hoy|ma[nñ]ana|ya)\b/i,
  /\boferta\s+(termina|acaba|caduca)\b/i,
];

const PROMPT_LEAK: RegExp[] = [
  /\b(mis|las)\s+instrucciones\b/i,
  /\bsystem\s+prompt\b/i,
  /\bprompt\s+del\s+sistema\b/i,
  /\b(mi|la)\s+ficha\s+de\s+producto\b/i,
  /\bmis\s+normas\b/i,
  /\bguion\s+interno\b/i,
];

const AI_TELLS: RegExp[] = [
  /excelente\s+pregunta/i,
  /(gran|buena)\s+pregunta/i,
  /entiendo\s+perfectamente/i,
  /no\s+dudes\s+en/i,
  /estar[eé]\s+encantad/i,
  /estoy\s+aqu[ií]\s+para/i,
  /como\s+asistente/i,
  /como\s+(modelo|inteligencia\s+artificial)/i,
  /espero\s+que\s+(esto|te\s+sirva|te\s+ayude)/i,
  /¡?claro\s+que\s+s[ií]/i,
  /por\s+supuesto/i,
  /en\s+resumen/i,
  /es\s+importante\s+(destacar|se[nñ]alar|tener\s+en\s+cuenta)/i,
  /te\s+animo\s+a/i,
  /sin\s+duda/i,
  /entiendo\s+que\b/i,
  /lo\s+siento,?\s+(pero\s+)?no\s+puedo/i,
  /quieres\s+que\s+profundic/i,
  /dise[nñ]ad[oa]\s+para/i,
  /\bvale,\s+perfecto\b/i,
  /aqu[ií]\s+tienes\s+algunos/i,
  /d[eé]jame\s+(explicarte|contarte)/i,
  /perm[ií]teme/i,
  /\bestimad[oa]\b/i,
];

// El patron "no es X, es Y" es el que mas delata un texto hecho con IA.
const NEGATIVE_PARALLEL =
  /\bno\s+(es|son|se\s+trata\s+de)\b[^.?!\n]{0,70}[,;:]\s*(es|son|sino)\b/i;

const SALESY_OPENING =
  /^\s*¡?\s*(genial|perfecto|estupendo|fant[aá]stico|excelente|qu[eé]\s+bien|maravilloso)\b/i;

const MARKDOWN = /\*\*|^#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)]\s|`/m;

const ASKS_IF_BOT =
  /\b(eres|sois|es\s+esto|hablo\s+con|estoy\s+hablando\s+con)\s+(un\s+|una\s+|el\s+|la\s+)?(bot|robot|ia|inteligencia\s+artificial|m[aá]quina|persona|humano|humana|real|chatgpt)\b|\b(bot|robot)\s*\?/i;

const ADMITS_AI = /\b(ia|inteligencia\s+artificial|asistente|autom[aá]tic)/i;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

const URL_LIKE =
  /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|es|ly|co|me|app|ai|gg|link|info|xyz|site|online|store|shop)\b(?:\/[^\s]*)?/gi;

const MONEY =
  /(\d[\d.,]*)\s*(?:€|euros?\b|\$|usd\b|d[oó]lares?\b)|(?:€|\$)\s*(\d[\d.,]*)/gi;

function hostOf(rawUrl: string): string {
  const withoutScheme = rawUrl.replace(/^https?:\/\//i, "").toLowerCase();
  return withoutScheme.split(/[/?#\s]/)[0].replace(/[.,;:!?)]+$/, "");
}

function isAllowedHost(host: string, allowedDomains: string[]): boolean {
  return allowedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.?!\n])\s+/);
}

const LEADING_PRAISE =
  /^\s*¡?\s*(genial|perfecto|estupendo|fant[aá]stico|excelente|qu[eé]\s+bien|maravilloso)\s*[!.,:;]+\s+(?=\S)/i;

/**
 * Arregla lo que no merece otra llamada a la IA: enfasis con asteriscos, rayas
 * largas y el elogio automatico del principio. No cambia lo que dice el mensaje.
 */
export function cleanMessage(message: string): string {
  const cleaned = message
    // Instagram no pinta los enlaces con formato: se deja la direccion tal cual.
    .replace(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, "$1")
    .replace(/\*\*?([^*\n]+)\*\*?/g, "$1")
    .replace(/\s*—\s*/g, ", ")
    .replace(LEADING_PRAISE, "")
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function checkMessages(
  messages: string[],
  context: GuardrailContext
): Violation[] {
  const violations: Violation[] = [];
  const add = (code: string, severity: ViolationSeverity, detail: string) =>
    violations.push({ code, severity, detail });

  if (messages.length === 0 || messages.every((message) => !message.trim())) {
    add("empty", "hard", "No hay ningun mensaje que enviar.");
    return violations;
  }
  if (messages.length > MAX_MESSAGES) {
    add("too_many_messages", "hard", `Maximo ${MAX_MESSAGES} mensajes.`);
  }

  const joined = messages.join("\n");
  const allowedAmounts = context.allowedAmounts ?? DEFAULT_ALLOWED_AMOUNTS;

  for (const message of messages) {
    if (message.length > MAX_MESSAGE_CHARS) {
      add("too_long", "hard", `Un mensaje pasa de ${MAX_MESSAGE_CHARS} letras.`);
    } else if (message.length > STYLE_MESSAGE_CHARS) {
      add("long_style", "style", "Demasiado largo para un chat: acortalo.");
    }
  }

  for (const pattern of CLAIMS_HUMAN) {
    if (pattern.test(joined)) {
      add("claims_human", "hard", "Dice o da a entender que es una persona.");
      break;
    }
  }
  for (const pattern of INCOME_PROMISES) {
    if (pattern.test(joined)) {
      add("income_promise", "hard", "Promete ingresos o resultados.");
      break;
    }
  }
  for (const sentence of sentences(joined)) {
    if (
      /garantiz/i.test(sentence) &&
      !/\b(no|nadie|sin|desconf[ií]a)\b/i.test(sentence)
    ) {
      add("income_promise", "hard", "Usa 'garantizar' sin negarlo.");
      break;
    }
  }
  for (const pattern of FALSE_SCARCITY) {
    if (pattern.test(joined)) {
      add("false_scarcity", "hard", "Inventa urgencia o escasez.");
      break;
    }
  }
  for (const pattern of PROMPT_LEAK) {
    if (pattern.test(joined)) {
      add("prompt_leak", "hard", "Habla de sus instrucciones internas.");
      break;
    }
  }

  for (const pattern of IMPOSSIBLE_PROMISES) {
    if (pattern.test(joined)) {
      add("impossible_promise", "hard", "Promete algo que no puedes hacer: avisar o guardar el email. Dile que deje el email en la web.");
      break;
    }
  }
  for (const pattern of INVENTED_FACTS) {
    if (pattern.test(joined)) {
      add("invented_fact", "hard", "Afirma algo que no sabes o da un plazo. Quítalo.");
      break;
    }
  }
  if (EMPTY_PRAISE.test(joined)) {
    add("empty_praise", "style", "No valores su tema ni su progreso: empieza por lo útil.");
  }
  if (
    context.alreadyInvited &&
    /(?<![a-z.-])marketnextia\.com/i.test(joined) &&
    !/\b(enlace|link|web|d[oó]nde|apunt|email|correo)/i.test(context.lastUserText)
  ) {
    add("repeated_invite", "style", "Ya has dejado el enlace de la web: no lo repitas.");
  }

  if (PERCENTAGE.test(joined)) {
    add("invented_stat", "hard", "Da un porcentaje: no hay ninguno que se pueda citar.");
  }

  for (const match of joined.matchAll(MONEY)) {
    const amount = match[1] ?? match[2] ?? "";
    if (!allowedAmounts.includes(amount.replace(/[.,]$/, ""))) {
      add("money_amount", "hard", `Importe no permitido: ${match[0]}.`);
      break;
    }
  }

  for (const match of joined.matchAll(URL_LIKE)) {
    if (!isAllowedHost(hostOf(match[0]), context.allowedDomains)) {
      add("link_not_allowed", "hard", `Enlace no permitido: ${match[0]}.`);
      break;
    }
  }

  if (ASKS_IF_BOT.test(context.lastUserText) && !ADMITS_AI.test(joined)) {
    add("must_admit_ai", "hard", "Han preguntado si es una IA y no lo admite.");
  }

  if (MARKDOWN.test(joined)) {
    add("markdown", "style", "Sin listas, negritas ni formato.");
  }
  for (const pattern of AI_TELLS) {
    if (pattern.test(joined)) {
      add("ai_tell", "style", `Frase de plantilla: ${pattern.source}.`);
      break;
    }
  }
  if (NEGATIVE_PARALLEL.test(joined)) {
    add("ai_tell", "style", "Evita el patron 'no es X, es Y'.");
  }
  if (joined.includes("—")) {
    add("em_dash", "style", "Sin rayas largas.");
  }
  if (messages.some((message) => SALESY_OPENING.test(message))) {
    add("salesy_opening", "style", "No empieces con un elogio automatico.");
  }
  if ((joined.match(/\?/g) ?? []).length > 1) {
    add("too_many_questions", "style", "Una sola pregunta cada vez.");
  }
  if ((joined.match(EMOJI) ?? []).length > 1) {
    add("too_many_emojis", "style", "Maximo un emoji.");
  }

  return violations;
}

export function hasHardViolation(violations: Violation[]): boolean {
  return violations.some((violation) => violation.severity === "hard");
}

/** Quien pide que no le escriban no pasa por la IA: se le hace caso y punto. */
const OPT_OUT =
  /\b(no\s+me\s+(escribas|escribais|escrib[aá]is|hables|mandes|env[ií]es)|d[eé]jame\s+en\s+paz|deja\s+de\s+(escribirme|mandarme|enviarme)|dejad\s+de\s+(escribirme|mandarme)|no\s+quiero\s+(m[aá]s\s+)?mensajes|date\s+de\s+baja|darme\s+de\s+baja|baja\s+de\s+esto)\b|^\s*(stop|baja)\s*[.!]*\s*$/i;

export function isOptOut(text: string): boolean {
  return OPT_OUT.test(text);
}

const MINOR = /\b(tengo|cumpl[ií]|voy\s+a\s+cumplir)\s+(1[0-7])\s*(a[nñ]os|tacos)?\b/i;

/** Un menor no recibe oferta de pago: lo decide el codigo, no la IA. */
export function saysIsMinor(text: string): boolean {
  return MINOR.test(text);
}
