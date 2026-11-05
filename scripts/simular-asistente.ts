/**
 * Simulador del asistente: conversaciones de prueba con personas inventadas.
 * Usa el mismo codigo de decision que produccion. No toca Instagram ni la base de
 * datos, y no contiene datos de nadie real.
 *
 * Uso:
 *   npx tsx scripts/simular-asistente.ts --conocimiento <carpeta> --salida <fichero.jsonl>
 *        [--modelo mistral-small-latest] [--solo id1,id2] [--max 50] [--paralelo 2]
 *
 * Claves: ASSISTANT_API_KEY (asistente) y PERSONA_API_KEY (quien hace de persona).
 */
import { appendFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  decideReply,
  DISCLOSURE_TEXT,
  mechanicalDecision,
  type ChatFn,
  type HistoryEntry,
} from "@/lib/assistant/engine";
import { createChat } from "@/lib/assistant/llm";
import { loadKnowledge } from "@/lib/assistant/knowledge";
import { PERSONAS, type Persona } from "./simular-asistente-personas";

const { values } = parseArgs({
  options: {
    conocimiento: { type: "string" },
    salida: { type: "string" },
    modelo: { type: "string", default: "mistral-small-latest" },
    solo: { type: "string" },
    max: { type: "string" },
    paralelo: { type: "string", default: "2" },
  },
});

const REVEAL_TEXT =
  "Aquí tienes la guía: https://guia.marketnextia.com ¿Empiezas de cero o ya tienes canal?";
const ALLOWED_DOMAINS = ["guia.marketnextia.com", "marketnextia.com"];
const MAX_REPLIES = 12;

async function withRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const retryable =
        (error as { retryable?: boolean }).retryable !== false;
      if (!retryable) break;
      await new Promise((resolve) =>
        setTimeout(resolve, 4_000 * (attempt + 1))
      );
    }
  }
  throw lastError;
}

function personaPrompt(persona: Persona): string {
  return `Estás en una prueba. Haces de persona real escribiendo por mensajes privados de Instagram a una cuenta llamada MarketNext. Comentaste en un reel sobre montar un canal de YouTube con IA y te han mandado una guía.

Quién eres: ${persona.quien}
Qué quieres en esta conversación: ${persona.objetivo}

Cómo escribes: mensajes muy cortos, como en el móvil, con faltas o sin tildes si encaja. Una o dos frases como mucho. No hagas de asistente ni ayudes a la otra parte. Reacciona a lo que te dice. Si ya tienes lo que querías o te cansas, escribe solo: FIN`;
}

function asPersonaChat(history: HistoryEntry[]) {
  // Para quien hace de persona, los papeles van al reves.
  return history.map((entry) => ({
    role: entry.role === "USER" ? ("assistant" as const) : ("user" as const),
    content: entry.text,
  }));
}

async function runConversation(
  persona: Persona,
  assistantChat: ChatFn,
  personaChat: ChatFn,
  knowledge: Awaited<ReturnType<typeof loadKnowledge>>
) {
  const history: HistoryEntry[] = [
    { role: "AUTOMATION", text: REVEAL_TEXT },
  ];
  const turns: Array<Record<string, unknown>> = [];
  let replyCount = 0;
  let disclosed = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let finished = "maximo_de_turnos";
  let userText = persona.primerMensaje;

  for (let turn = 0; turn < persona.turnos; turn++) {
    history.push({ role: "USER", text: userText });

    const fixed = mechanicalDecision({
      pendingText: userText,
      repliesSoFar: replyCount,
      maxReplies: MAX_REPLIES,
    });
    const decision =
      fixed ??
      (await withRetry(() =>
        decideReply({
          chat: assistantChat,
          knowledge,
          facts: {
            entry: "comentario",
            receivedGuide: true,
            repliesSoFar: replyCount,
            maxReplies: MAX_REPLIES,
          },
          history,
          allowedDomains: ALLOWED_DOMAINS,
        })
      ));

    inputTokens += decision.inputTokens;
    outputTokens += decision.outputTokens;
    const outgoing = [...decision.messages];
    if (!disclosed && !fixed) {
      outgoing.unshift(DISCLOSURE_TEXT);
      disclosed = true;
    }
    for (const text of outgoing) history.push({ role: "ASSISTANT", text });
    replyCount += 1;

    turns.push({
      usuario: userText,
      respuestas: outgoing,
      accion: decision.action,
      etapa: decision.stage,
      motivo: decision.reason,
      intentos: decision.attempts,
      forzado: decision.forcedHandoff,
      fijo: Boolean(fixed),
      avisos: decision.violations.map((violation) => violation.code),
    });

    if (decision.action !== "responder") {
      finished = decision.action;
      break;
    }

    const next = await withRetry(() =>
      personaChat([
        { role: "system", content: personaPrompt(persona) },
        ...asPersonaChat(history),
      ])
    );
    const raw = next.content.trim().replace(/^"|"$/g, "");
    const nextText = raw.replace(/\s*\.?\s*\bFIN\s*\.?\s*$/, "").trim();
    if (!nextText) {
      finished = "la_persona_termina";
      break;
    }
    userText = nextText;
    if (raw !== nextText) {
      // Lo ultimo que dice antes de irse tambien recibe respuesta.
      turn = Math.max(turn, persona.turnos - 2);
    }
  }

  return {
    id: persona.id,
    categoria: persona.categoria,
    espera: persona.espera,
    terminado: finished,
    respuestas: replyCount,
    tokensEntrada: inputTokens,
    tokensSalida: outputTokens,
    turnos: turns,
  };
}

async function main() {
  if (!values.conocimiento || !values.salida) {
    throw new Error("Faltan --conocimiento y --salida");
  }
  const assistantKey = process.env.ASSISTANT_API_KEY;
  const personaKey = process.env.PERSONA_API_KEY;
  if (!assistantKey || !personaKey) {
    throw new Error("Faltan ASSISTANT_API_KEY o PERSONA_API_KEY");
  }

  const knowledge = await loadKnowledge(values.conocimiento);
  const assistantChat = createChat({
    apiUrl:
      process.env.ASSISTANT_API_URL ??
      "https://api.mistral.ai/v1/chat/completions",
    apiKey: assistantKey,
    model: values.modelo as string,
  });
  const personaChat = createChat({
    apiUrl:
      process.env.PERSONA_API_URL ??
      "https://api.groq.com/openai/v1/chat/completions",
    apiKey: personaKey,
    model: process.env.PERSONA_MODEL ?? "openai/gpt-oss-120b",
    temperature: 0.9,
    maxTokens: 800,
    jsonMode: false,
  });

  const only = values.solo?.split(",");
  let personas = only
    ? PERSONAS.filter((persona) => only.includes(persona.id))
    : PERSONAS;
  if (values.max) personas = personas.slice(0, Number(values.max));

  await writeFile(values.salida, "");
  const queue = [...personas];
  let done = 0;

  async function worker() {
    for (;;) {
      const persona = queue.shift();
      if (!persona) return;
      try {
        const result = await runConversation(
          persona,
          assistantChat,
          personaChat,
          knowledge
        );
        await appendFile(values.salida!, `${JSON.stringify(result)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "desconocido";
        await appendFile(
          values.salida!,
          `${JSON.stringify({ id: persona.id, error: message })}\n`
        );
      }
      done += 1;
      console.log(`${done}/${personas.length} ${persona.id}`);
    }
  }

  await Promise.all(
    Array.from({ length: Number(values.paralelo) }, () => worker())
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
