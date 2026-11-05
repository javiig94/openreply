/**
 * Configuracion del asistente de mensajes privados.
 *
 * Todo sale del entorno para poder cambiarlo sin fabricar otra imagen. El
 * interruptor general no esta aqui: vive en la base de datos (AssistantSettings)
 * para que Javi pueda apagarlo desde el panel.
 */
import path from "node:path";

export interface AssistantConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  knowledgeDir: string;
  maxRepliesPerConversation: number;
  maxRepliesPerDay: number;
  allowedDomains: string[];
  notifyEmail: string | null;
  retentionDays: number;
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function getAssistantConfig(
  env: Record<string, string | undefined> = process.env
): AssistantConfig {
  const domains = listFromEnv(env.ASSISTANT_ALLOWED_DOMAINS);
  return {
    apiUrl:
      env.ASSISTANT_API_URL ?? "https://api.mistral.ai/v1/chat/completions",
    apiKey: env.ASSISTANT_API_KEY ?? "",
    model: env.ASSISTANT_MODEL ?? "mistral-large-4",
    maxOutputTokens: intFromEnv(env.ASSISTANT_MAX_OUTPUT_TOKENS, 1500),
    knowledgeDir:
      env.ASSISTANT_KNOWLEDGE_DIR ?? path.join(process.cwd(), "asistente"),
    maxRepliesPerConversation: intFromEnv(env.ASSISTANT_MAX_REPLIES, 12),
    maxRepliesPerDay: intFromEnv(env.ASSISTANT_MAX_REPLIES_PER_DAY, 300),
    allowedDomains: domains.length
      ? domains
      : ["guia.marketnextia.com", "marketnextia.com"],
    notifyEmail:
      env.ASSISTANT_NOTIFY_EMAIL ?? listFromEnv(env.ALLOWED_EMAILS)[0] ?? null,
    retentionDays: intFromEnv(env.ASSISTANT_RETENTION_DAYS, 180),
  };
}

/** Sin clave real el asistente no puede contestar, aunque este encendido. */
export function isAssistantConfigured(config: AssistantConfig): boolean {
  return Boolean(config.apiKey) && !config.apiKey.startsWith("PENDIENTE");
}
