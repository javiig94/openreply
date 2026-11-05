import { describe, it, expect, vi } from "vitest";
import {
  decideReply,
  HANDOFF_TEXT,
  historyToChat,
  parseDecision,
  type ChatFn,
} from "@/lib/assistant/engine";
import { createChat } from "@/lib/assistant/llm";
import { MESSAGING_WINDOW_MS, reminderTime, replyDelayMs, typingMs } from "@/lib/assistant/timing";
import { getAssistantConfig, isAssistantConfigured } from "@/lib/assistant/config";

const knowledge = { ficha: "f", guion: "g", normas: "n", ejemplos: "e" };
const facts = {
  entry: "comentario" as const,
  receivedGuide: true,
  repliesSoFar: 0,
  maxReplies: 12,
};
const allowedDomains = ["marketnextia.com"];
const history = [{ role: "USER" as const, text: "hola" }];

function respuestas(...contenidos: string[]): ChatFn {
  const chat = vi.fn();
  for (const content of contenidos) {
    chat.mockResolvedValueOnce({ content, inputTokens: 10, outputTokens: 5 });
  }
  return chat as unknown as ChatFn;
}

const json = (mensajes: string[], accion = "responder") =>
  JSON.stringify({ accion, mensajes, etapa: "ayuda", motivo: "m" });

describe("decideReply", () => {
  it("envía lo que propone la IA si cumple las normas", async () => {
    const decision = await decideReply({
      chat: respuestas(json(["Vale. ¿Tienes ya canal?"])),
      knowledge,
      facts,
      history,
      allowedDomains,
    });
    expect(decision.action).toBe("responder");
    expect(decision.messages).toEqual(["Vale. ¿Tienes ya canal?"]);
    expect(decision.forcedHandoff).toBe(false);
    expect(decision.inputTokens).toBe(10);
  });

  it("pide reescribir y usa la segunda versión si la primera falla", async () => {
    const chat = respuestas(
      json(["Vas a ganar un montón"]),
      json(["Hay gente que lo consigue, depende de tu trabajo."])
    );
    const decision = await decideReply({
      chat,
      knowledge,
      facts,
      history,
      allowedDomains,
    });
    expect(decision.messages[0]).toContain("depende de tu trabajo");
    expect(decision.attempts).toBe(2);
    expect(decision.inputTokens).toBe(20);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("pasa a una persona si la norma dura sigue incumplida: nada de la IA sale", async () => {
    const decision = await decideReply({
      chat: respuestas(
        json(["Vas a ganar 1.000 €"]),
        json(["Ganarás 2.000 €"]),
        json(["Son 3.000 €"])
      ),
      knowledge,
      facts,
      history,
      allowedDomains,
    });
    expect(decision.action).toBe("pasar_a_persona");
    expect(decision.forcedHandoff).toBe(true);
    expect(decision.messages).toEqual([HANDOFF_TEXT]);
    expect(decision.blocked).toEqual(["Son 3.000 €"]);
  });

  it("envía igualmente si solo queda un fallo de estilo", async () => {
    const decision = await decideReply({
      chat: respuestas(json(["¿Y el tema? ¿Y el canal?"]), json(["¿Tienes tema? ¿Y canal?"])),
      knowledge,
      facts,
      history,
      allowedDomains,
    });
    expect(decision.forcedHandoff).toBe(false);
    expect(decision.messages).toEqual(["¿Tienes tema? ¿Y canal?"]);
    expect(decision.violations.map((v) => v.code)).toContain("too_many_questions");
  });

  it("pasa a una persona si la IA nunca devuelve un JSON válido", async () => {
    const decision = await decideReply({
      chat: respuestas("no es json", "tampoco", "nada"),
      knowledge,
      facts,
      history,
      allowedDomains,
    });
    expect(decision.forcedHandoff).toBe(true);
  });

  it("obliga a admitir que es una IA en la conversación real", async () => {
    const decision = await decideReply({
      chat: respuestas(
        json(["Claro, dime."]),
        json(["Dime qué necesitas."]),
        json(["Cuéntame."])
      ),
      knowledge,
      facts,
      history: [{ role: "USER", text: "oye, ¿eres un bot?" }],
      allowedDomains,
    });
    expect(decision.forcedHandoff).toBe(true);
  });
});

describe("historyToChat", () => {
  it("une los mensajes seguidos y trata campañas y personas del equipo como la cuenta", () => {
    expect(
      historyToChat([
        { role: "AUTOMATION", text: "guía" },
        { role: "ASSISTANT", text: "aviso" },
        { role: "USER", text: "hola" },
        { role: "USER", text: "de cero" },
        { role: "HUMAN", text: "soy del equipo" },
      ])
    ).toEqual([
      { role: "assistant", content: "guía\naviso" },
      { role: "user", content: "hola\nde cero" },
      { role: "assistant", content: "soy del equipo" },
    ]);
  });
});

describe("createChat", () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "hola" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      })
    );
  const chat = () =>
    createChat({ apiUrl: "http://x", apiKey: "k", model: "m", retryWaitsMs: [0, 0] });

  it("reintenta si hay un límite de uso momentáneo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat()([])).resolves.toMatchObject({ content: "hola", inputTokens: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("no reintenta si la clave es mala, ni guarda el cuerpo del error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("secreto", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat()([])).rejects.toThrow("error 401");
    await expect(chat()([])).rejects.not.toThrow("secreto");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("entiende el texto por partes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: "thinking", text: "no" },
                    { type: "text", text: "sí" },
                  ],
                },
              },
            ],
          })
        )
      )
    );
    await expect(chat()([])).resolves.toMatchObject({ content: "sí" });
    vi.unstubAllGlobals();
  });
});

describe("parseDecision", () => {
  it("rescata el JSON aunque venga con texto alrededor", () => {
    expect(
      parseDecision('Aquí va: {"accion":"cerrar","mensajes":["Hasta luego"]} fin')
    ).toMatchObject({ action: "cerrar", messages: ["Hasta luego"] });
  });
  it("rechaza acciones desconocidas", () => {
    expect(parseDecision('{"accion":"vender","mensajes":["x"]}')).toBeNull();
  });
});

describe("tiempos", () => {
  it("espera entre 30 y 90 segundos", () => {
    expect(replyDelayMs("hola", () => 0)).toBeGreaterThanOrEqual(30_000);
    expect(replyDelayMs("x".repeat(5000), () => 1)).toBeLessThanOrEqual(90_000);
  });

  it("escribe más tiempo si el mensaje es largo, con tope", () => {
    expect(typingMs("hola", () => 0)).toBeLessThan(typingMs("x".repeat(100), () => 0));
    expect(typingMs("x".repeat(9999), () => 1)).toBeLessThanOrEqual(8_000);
  });

  it("el recordatorio cae siempre dentro de la ventana y de día en Madrid", () => {
    for (let hour = 0; hour < 24; hour++) {
      const start = new Date(Date.UTC(2026, 10, 5, hour, 0, 0));
      const when = reminderTime(start);
      expect(when).not.toBeNull();
      const elapsed = when!.getTime() - start.getTime();
      expect(elapsed).toBeLessThan(MESSAGING_WINDOW_MS);
      expect(elapsed).toBeGreaterThanOrEqual(12 * 3_600_000);
      const local = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Madrid",
          hour: "2-digit",
          hour12: false,
        }).format(when!)
      );
      expect(local).toBeGreaterThanOrEqual(9);
      expect(local).toBeLessThan(22);
    }
  });
});

describe("configuración", () => {
  it("sin clave real no se considera configurado", () => {
    expect(isAssistantConfigured(getAssistantConfig({}))).toBe(false);
    expect(
      isAssistantConfigured(getAssistantConfig({ ASSISTANT_API_KEY: "PENDIENTE_IA" }))
    ).toBe(false);
    expect(
      isAssistantConfigured(getAssistantConfig({ ASSISTANT_API_KEY: "abc" }))
    ).toBe(true);
  });

  it("avisa al correo de acceso si no se indica otro", () => {
    expect(
      getAssistantConfig({ ALLOWED_EMAILS: "uno@x.com,dos@x.com" }).notifyEmail
    ).toBe("uno@x.com");
  });
});
