/**
 * Llamada a la IA por el formato de chat que comparten Mistral, Groq y otros.
 * Cambiar de proveedor es cambiar tres variables de entorno.
 */
import type { ChatFn, ChatMessage, ChatResult } from "./engine";

const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_WAITS_MS = [3_000, 8_000];

export class AssistantLlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "AssistantLlmError";
  }
}

export function createChat({
  apiUrl,
  apiKey,
  model,
  temperature = 0.4,
  maxTokens = 400,
  jsonMode = true,
  retryWaitsMs = RETRY_WAITS_MS,
}: {
  apiUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  retryWaitsMs?: number[];
}): ChatFn {
  const once = async (messages: ChatMessage[]): Promise<ChatResult> => {
    let response: Response;
    try {
      response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.name : "desconocido";
      throw new AssistantLlmError(`Sin respuesta de la IA (${detail})`, true);
    }

    if (!response.ok) {
      // El cuerpo de error no se guarda: podria repetir parte de la peticion.
      throw new AssistantLlmError(
        `La IA respondió con error ${response.status}`,
        response.status === 429 || response.status >= 500
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Algunos modelos devuelven el texto por partes, junto con su razonamiento.
    const rawContent = data.choices?.[0]?.message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("")
      : rawContent;
    if (typeof content !== "string" || !content.trim()) {
      throw new AssistantLlmError("La IA devolvió una respuesta vacía", true);
    }
    return {
      content,
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    };
  };

  // Un limite de uso momentaneo se resuelve esperando unos segundos: si un reel
  // trae muchos mensajes a la vez, no debe acabar en avisos a una persona.
  return async (messages: ChatMessage[]): Promise<ChatResult> => {
    for (const wait of retryWaitsMs) {
      try {
        return await once(messages);
      } catch (error) {
        if (!(error instanceof AssistantLlmError) || !error.retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    return once(messages);
  };
}
