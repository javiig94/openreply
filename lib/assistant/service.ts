/**
 * El asistente conectado a la base de datos, la cola e Instagram.
 *
 * Regla de construccion: un fallo aqui no puede romper las campanas originales.
 * Lo que se llama desde sus flujos ("assistantOn...") nunca lanza errores.
 */
import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import {
  ASSISTANT_REMINDER_JOB_NAME,
  ASSISTANT_REPLY_JOB_NAME,
  getDMQueue,
  type AssistantEchoJob,
  type AssistantReminderJob,
  type AssistantReplyJob,
} from "@/lib/queue/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  resolveRecipientName,
  sendDirectMessage,
  sendSenderAction,
  type InstagramContext,
} from "@/lib/instagram/provider";
import {
  classifySendError,
  isConfirmedSendRejection,
} from "@/lib/instagram/delivery-errors";
import {
  getAssistantConfig,
  isAssistantConfigured,
  type AssistantConfig,
} from "./config";
import {
  decideReply,
  mechanicalDecision,
  DISCLOSURE_TEXT,
  REMINDER_TEXT,
  REMINDER_WITH_DISCLOSURE_TEXT,
  type HistoryEntry,
} from "./engine";
import { createChat } from "./llm";
import { loadKnowledge } from "./knowledge";
import { notifyHandoff } from "./notify";
import {
  MESSAGING_WINDOW_MS,
  reminderTime,
  replyDelayMs,
  typingMs,
} from "./timing";

const HISTORY_LIMIT = 30;
const HUMAN_PAUSE_MS = 24 * 3_600_000;
const OWN_ECHO_WINDOW_MS = 10 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Sin contenido de mensajes en los registros: Prisma puede citar los datos. */
function logSafe(where: string, error: unknown): void {
  const name = error instanceof Error ? error.name : "Unknown";
  const detail = name.startsWith("Prisma")
    ? String((error as { code?: unknown }).code ?? "")
    : error instanceof Error
      ? error.message.slice(0, 200)
      : "";
  console.error(`[Assistant] ${where}: ${name} ${detail}`);
}

/** Devuelve la cuenta solo si el asistente puede trabajar en ella. */
async function getActiveAccount(instagramId: string) {
  const config = getAssistantConfig();
  if (!isAssistantConfigured(config)) return null;
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    include: { workspace: { select: { assistantSettings: true } } },
  });
  if (!account?.workspace.assistantSettings?.enabled) return null;
  return { account, config };
}

function windowIsOpen(lastUserMessageAt: Date | null): boolean {
  return (
    lastUserMessageAt !== null &&
    Date.now() - lastUserMessageAt.getTime() < MESSAGING_WINDOW_MS
  );
}

/**
 * Conversacion en marcha: ya recibio la campana o ya hablo con el asistente, y sigue
 * dentro de las 24 h. Asi "de cero, gracias por la guia" no vuelve a disparar la campana.
 */
export async function assistantOwnsConversation(
  instagramId: string,
  igUserId: string
): Promise<boolean> {
  try {
    const active = await getActiveAccount(instagramId);
    if (!active) return false;
    const conversation = await prisma.assistantConversation.findUnique({
      where: {
        instagramAccountId_igUserId: {
          instagramAccountId: active.account.id,
          igUserId,
        },
      },
      select: {
        status: true,
        replyCount: true,
        lastUserMessageAt: true,
        messages: {
          where: { role: "AUTOMATION" },
          take: 1,
          select: { id: true },
        },
      },
    });
    return (
      conversation?.status === "ACTIVE" &&
      (conversation.replyCount > 0 || conversation.messages.length > 0) &&
      windowIsOpen(conversation.lastUserMessageAt)
    );
  } catch (error) {
    logSafe("assistantOwnsConversation", error);
    return false;
  }
}

async function scheduleReminder(
  instagramId: string,
  conversationId: string,
  anchor: Date
): Promise<void> {
  const when = reminderTime(anchor);
  if (!when) return;
  await getDMQueue().add(
    ASSISTANT_REMINDER_JOB_NAME,
    {
      instagramAccountId: instagramId,
      conversationId,
      anchorMs: anchor.getTime(),
    },
    {
      delay: Math.max(0, when.getTime() - Date.now()),
      jobId: `assistant_reminder_${conversationId}_${anchor.getTime()}`,
    }
  );
}

function enqueueReply(
  instagramId: string,
  conversationId: string,
  messageId: string,
  text: string
) {
  return getDMQueue().add(
    ASSISTANT_REPLY_JOB_NAME,
    {
      instagramAccountId: instagramId,
      conversationId,
      triggerMessageId: messageId,
    },
    {
      delay: replyDelayMs(text),
      jobId: `assistant_reply_${shortHash(messageId)}`,
    }
  );
}

export async function assistantOnInboundMessage({
  instagramId,
  igUserId,
  messageId,
  text,
  handledByCampaign,
}: {
  instagramId: string;
  igUserId: string;
  messageId: string;
  text: string;
  handledByCampaign: boolean;
}): Promise<void> {
  try {
    const active = await getActiveAccount(instagramId);
    if (!active) return;
    const { account } = active;

    const known = await prisma.assistantMessage.findUnique({
      where: { externalId: messageId },
      select: { id: true, conversationId: true },
    });
    if (known) {
      // Reentrega del mismo mensaje. Se vuelve a pedir la respuesta por si la cola
      // fallo la primera vez: el trabajo no contesta dos veces al mismo mensaje.
      if (!handledByCampaign) {
        await enqueueReply(instagramId, known.conversationId, known.id, text);
      }
      return;
    }

    const now = new Date();
    const conversation = await prisma.assistantConversation.upsert({
      where: {
        instagramAccountId_igUserId: {
          instagramAccountId: account.id,
          igUserId,
        },
      },
      create: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        igUserId,
        lastUserMessageAt: now,
      },
      update: { lastUserMessageAt: now },
    });

    const message = await prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        text,
        externalId: messageId,
      },
    });

    // Quien pidio que no le escribieran solo vuelve si lo pide con la palabra de la
    // campana: un "gracias" suelto no le reactiva.
    if (conversation.status === "OPTED_OUT" && !handledByCampaign) return;

    const pauseEnded =
      conversation.status === "PAUSED_HUMAN" &&
      (!conversation.pausedUntil || conversation.pausedUntil <= now);
    if (
      conversation.status === "OPTED_OUT" ||
      conversation.status === "CLOSED" ||
      pauseEnded
    ) {
      await prisma.assistantConversation.update({
        where: { id: conversation.id },
        data: { status: "ACTIVE", pausedUntil: null },
      });
    } else if (conversation.status !== "ACTIVE") {
      return; // Lo lleva una persona.
    }

    await scheduleReminder(instagramId, conversation.id, now);

    if (handledByCampaign) return;
    await enqueueReply(instagramId, conversation.id, message.id, text);
  } catch (error) {
    logSafe("assistantOnInboundMessage", error);
  }
}

export async function assistantOnCampaignDelivered({
  instagramId,
  igUserId,
  username,
  text,
  openedByUser,
}: {
  instagramId: string;
  igUserId: string;
  username: string | null;
  text: string;
  /** Pulso el boton: eso abre las 24 h de Meta sin que haya escrito nada. */
  openedByUser: boolean;
}): Promise<void> {
  try {
    const active = await getActiveAccount(instagramId);
    if (!active) return;
    const { account } = active;
    const now = new Date();

    const conversation = await prisma.assistantConversation.upsert({
      where: {
        instagramAccountId_igUserId: {
          instagramAccountId: account.id,
          igUserId,
        },
      },
      create: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        igUserId,
        username,
        lastUserMessageAt: openedByUser ? now : null,
      },
      update: {
        ...(username ? { username } : {}),
        ...(openedByUser ? { lastUserMessageAt: now } : {}),
      },
    });

    await prisma.assistantMessage.create({
      data: {
        conversationId: conversation.id,
        role: "AUTOMATION",
        text: text.replace(/\{username\}/g, username ?? "").trim(),
      },
    });

    if (openedByUser && conversation.status === "ACTIVE") {
      await scheduleReminder(instagramId, conversation.id, now);
    }
  } catch (error) {
    logSafe("assistantOnCampaignDelivered", error);
  }
}

type LoadedConversation = NonNullable<
  Awaited<ReturnType<typeof loadConversation>>
>;

function loadConversation(conversationId: string) {
  return prisma.assistantConversation.findUnique({
    where: { id: conversationId },
    include: {
      instagramAccount: {
        include: { workspace: { select: { assistantSettings: true } } },
      },
    },
  });
}

async function openContext(
  conversation: LoadedConversation,
  operationId: string
): Promise<InstagramContext | null> {
  if (!hasInstagramCredentials(conversation.instagramAccount)) return null;
  return createInstagramContext(conversation.instagramAccount, operationId);
}

/**
 * Se guarda antes de enviar para reconocer su propio eco, que puede llegar antes
 * de que Instagram conteste. Solo se retira si Meta lo rechaza de forma explicita;
 * con cualquier otro fallo no se sabe si salio, asi que se queda y no se repite.
 */
async function sendAndRecord({
  context,
  conversation,
  text,
  inReplyToId,
}: {
  context: InstagramContext;
  conversation: LoadedConversation;
  text: string;
  inReplyToId: string | null;
}): Promise<void> {
  const row = await prisma.assistantMessage.create({
    data: {
      conversationId: conversation.id,
      role: "ASSISTANT",
      text,
      inReplyToId,
    },
  });
  let messageId: string;
  try {
    const sent = await sendDirectMessage({
      context,
      instagramAccountId: conversation.instagramAccount.instagramId,
      userId: conversation.igUserId,
      message: text,
    });
    messageId = sent.message_id;
  } catch (error) {
    if (isConfirmedSendRejection(error)) {
      await prisma.assistantMessage.delete({ where: { id: row.id } });
    }
    // Lo "sin confirmar" corta los reintentos en el trabajo: asi no se duplica.
    throw classifySendError(error);
  }
  // Ya ha salido: un fallo al anotarlo no puede provocar otro envio.
  await prisma.assistantMessage
    .update({ where: { id: row.id }, data: { externalId: messageId } })
    .catch((error: unknown) => logSafe("sendAndRecord", error));
}

async function typing(
  context: InstagramContext,
  conversation: LoadedConversation,
  text: string
): Promise<void> {
  try {
    await sendSenderAction({
      context,
      instagramAccountId: conversation.instagramAccount.instagramId,
      userId: conversation.igUserId,
      action: "typing_on",
    });
  } catch (error) {
    logSafe("typing", error);
  }
  await sleep(typingMs(text));
}

async function handOff(
  conversation: LoadedConversation,
  reason: string
): Promise<void> {
  await prisma.assistantConversation.update({
    where: { id: conversation.id },
    data: { status: "HANDED_OFF", handoffReason: reason },
  });
  const config = getAssistantConfig();
  await notifyHandoff({
    to: config.notifyEmail,
    username: conversation.username,
    reason,
  });
}

function buildHistory(
  rows: Array<{ role: HistoryEntry["role"]; text: string }>
): HistoryEntry[] {
  return rows.map((row) => ({ role: row.role, text: row.text }));
}

async function resolveFacts(
  conversation: LoadedConversation,
  config: AssistantConfig
) {
  const firstSent = await prisma.dmLog.findFirst({
    where: {
      workspaceId: conversation.workspaceId,
      commenterId: conversation.igUserId,
      status: "SENT",
    },
    orderBy: { createdAt: "asc" },
    select: { commentId: true },
  });
  return {
    entry: firstSent?.commentId.startsWith("dm:")
      ? ("mensaje_directo" as const)
      : firstSent
        ? ("comentario" as const)
        : ("mensaje_directo" as const),
    receivedGuide: Boolean(firstSent),
    repliesSoFar: conversation.replyCount,
    maxReplies: config.maxRepliesPerConversation,
  };
}

async function reachedDailyCap(
  workspaceId: string,
  config: AssistantConfig
): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const sent = await prisma.assistantMessage.count({
    where: {
      role: "ASSISTANT",
      createdAt: { gte: since },
      conversation: { workspaceId },
    },
  });
  return sent >= config.maxRepliesPerDay;
}

export async function processAssistantReply(
  job: Job<AssistantReplyJob>
): Promise<void> {
  const { conversationId, triggerMessageId } = job.data;
  const config = getAssistantConfig();
  if (!isAssistantConfigured(config)) return;

  const conversation = await loadConversation(conversationId);
  if (!conversation) return;
  if (!conversation.instagramAccount.workspace.assistantSettings?.enabled) return;
  if (conversation.status !== "ACTIVE") return;
  if (!windowIsOpen(conversation.lastUserMessageAt)) return;

  const lastUser = await prisma.assistantMessage.findFirst({
    where: { conversationId, role: "USER" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  // Ha llegado otro mensaje despues: lo contesta su propio trabajo, y de una vez.
  if (lastUser?.id !== triggerMessageId) return;

  const alreadyAnswered = await prisma.assistantMessage.findFirst({
    where: { conversationId, inReplyToId: triggerMessageId },
    select: { id: true },
  });
  if (alreadyAnswered) return;

  if (await reachedDailyCap(conversation.workspaceId, config)) {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: conversation.workspaceId,
        source: "WORKER",
        level: "ERROR",
        message: "Asistente: alcanzado el tope diario de mensajes",
        payload: { limit: config.maxRepliesPerDay },
      },
    });
    return;
  }

  const rows = await prisma.assistantMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  const history = buildHistory(rows.reverse());

  // Lo que escribio de seguido desde la ultima respuesta cuenta como una sola cosa.
  const pending: string[] = [];
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].role !== "USER") break;
    pending.unshift(history[index].text);
  }

  const context = await openContext(conversation, `assistant:${triggerMessageId}`);
  if (!context) return;

  if (!conversation.username) {
    const username = await resolveRecipientName({
      context,
      workspaceId: conversation.workspaceId,
      recipientId: conversation.igUserId,
    }).catch(() => null);
    if (username) conversation.username = username;
  }

  const fixed = mechanicalDecision({
    pendingText: pending.join("\n"),
    repliesSoFar: conversation.replyCount,
    maxReplies: config.maxRepliesPerConversation,
  });

  let decision;
  if (fixed) {
    decision = fixed;
  } else {
    try {
      const knowledge = await loadKnowledge(config.knowledgeDir);
      decision = await decideReply({
        chat: createChat({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          model: config.model,
          maxTokens: config.maxOutputTokens,
        }),
        knowledge,
        facts: await resolveFacts(conversation, config),
        history,
        allowedDomains: config.allowedDomains,
      });
    } catch (error) {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 < attempts) throw error;
      // Sin IA despues de todos los intentos: que lo vea una persona.
      await handOff(conversation, "La IA no ha respondido tras varios intentos");
      return;
    }
  }

  // El estado va primero: si el envio falla, quien pidio parar o paso a una persona
  // no debe seguir recibiendo mensajes ni el recordatorio.
  const nextStatus =
    decision.action === "cerrar"
      ? "CLOSED"
      : decision.action === "dejar_de_escribir"
        ? "OPTED_OUT"
        : "ACTIVE";
  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      username: conversation.username,
      status: nextStatus,
      stage: decision.stage || conversation.stage,
      replyCount: { increment: 1 },
      inputTokens: { increment: decision.inputTokens },
      outputTokens: { increment: decision.outputTokens },
    },
  });
  if (decision.action === "pasar_a_persona") {
    await handOff(conversation, decision.reason || "La IA pide ayuda");
  }

  // El aviso no cuenta como respuesta: si lo siguiente falla, el reintento contesta
  // de verdad y no vuelve a avisar.
  if (!conversation.disclosedAt && decision.action !== "dejar_de_escribir") {
    await typing(context, conversation, DISCLOSURE_TEXT);
    await sendAndRecord({
      context,
      conversation,
      text: DISCLOSURE_TEXT,
      inReplyToId: null,
    });
    await prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { disclosedAt: new Date() },
    });
  }

  for (const text of decision.messages) {
    await typing(context, conversation, text);
    await sendAndRecord({
      context,
      conversation,
      text,
      inReplyToId: triggerMessageId,
    });
  }
}

export async function processAssistantReminder(
  job: Job<AssistantReminderJob>
): Promise<void> {
  const { conversationId, anchorMs } = job.data;
  const config = getAssistantConfig();
  if (!isAssistantConfigured(config)) return;

  const conversation = await loadConversation(conversationId);
  if (!conversation) return;
  if (!conversation.instagramAccount.workspace.assistantSettings?.enabled) return;
  if (conversation.status !== "ACTIVE" || conversation.reminderSentAt) return;
  // Ha vuelto a escribir o pulsar despues: este recordatorio ya no toca.
  if (conversation.lastUserMessageAt?.getTime() !== anchorMs) return;
  if (!windowIsOpen(conversation.lastUserMessageAt)) return;
  if (await reachedDailyCap(conversation.workspaceId, config)) return;

  const context = await openContext(conversation, `reminder:${conversationId}`);
  if (!context) return;

  // Se marca antes de enviar: mejor perder un recordatorio que mandar dos.
  const disclosed = Boolean(conversation.disclosedAt);
  await prisma.assistantConversation.update({
    where: { id: conversationId },
    data: {
      reminderSentAt: new Date(),
      ...(disclosed ? {} : { disclosedAt: new Date() }),
    },
  });
  await sendAndRecord({
    context,
    conversation,
    text: disclosed ? REMINDER_TEXT : REMINDER_WITH_DISCLOSURE_TEXT,
    inReplyToId: null,
  });
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Textos fijos de las campanas que no estan en la base de datos.
const BUILT_IN_CAMPAIGN_TEXTS = [
  process.env.FOLLOW_RECHECK_ACK_MESSAGE ?? null,
  "Almost there! Follow me and tap the button below to grab your link",
  "quick favor",
];

/**
 * Reconoce el texto de una campana aunque lleve el nombre de la persona: busca el
 * trozo fijo mas largo de la plantilla, sin las variables y sin el enlace.
 */
export function looksLikeCampaignText(
  echo: string,
  templates: Array<string | null | undefined>
): boolean {
  const target = normalize(echo);
  return templates.some((template) => {
    if (!template) return false;
    const pieces = template
      .replace(/https?:\/\/\S+/g, "{}")
      .split(/\{[^}]*\}/)
      .map((piece) => normalize(piece))
      .sort((a, b) => b.length - a.length);
    const longest = pieces[0]?.slice(0, 40) ?? "";
    return longest.length >= 8 && target.includes(longest);
  });
}

export async function processAssistantEcho(
  job: Job<AssistantEchoJob>
): Promise<void> {
  const { instagramAccountId, recipientId, messageId, text } = job.data;
  const active = await getActiveAccount(instagramAccountId);
  if (!active) return;
  const { account } = active;

  const conversation = await prisma.assistantConversation.findUnique({
    where: {
      instagramAccountId_igUserId: {
        instagramAccountId: account.id,
        igUserId: recipientId,
      },
    },
    select: { id: true },
  });

  if (conversation) {
    const own = await prisma.assistantMessage.findFirst({
      where: {
        conversationId: conversation.id,
        OR: [
          { externalId: messageId },
          {
            role: { in: ["ASSISTANT", "HUMAN"] },
            text,
            createdAt: { gte: new Date(Date.now() - OWN_ECHO_WINDOW_MS) },
          },
        ],
      },
      select: { id: true },
    });
    if (own) return;
  }

  const automations = await prisma.automation.findMany({
    where: { instagramAccountId: account.id },
    select: {
      dmMessage: true,
      openingDmMessage: true,
      followUpMessage: true,
      followPromptMessage: true,
    },
  });
  const isCampaign = automations.some((automation) =>
    looksLikeCampaignText(text, [
      automation.dmMessage,
      automation.openingDmMessage,
      automation.followUpMessage,
      automation.followPromptMessage,
      ...BUILT_IN_CAMPAIGN_TEXTS,
    ])
  );
  if (isCampaign) return;

  // Lo ha escrito una persona: el asistente se aparta 24 h en esta conversacion.
  const pausedUntil = new Date(Date.now() + HUMAN_PAUSE_MS);
  const updated = await prisma.assistantConversation.upsert({
    where: {
      instagramAccountId_igUserId: {
        instagramAccountId: account.id,
        igUserId: recipientId,
      },
    },
    create: {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      igUserId: recipientId,
      status: "PAUSED_HUMAN",
      pausedUntil,
    },
    update: { status: "PAUSED_HUMAN", pausedUntil },
  });
  await prisma.assistantMessage.create({
    data: {
      conversationId: updated.id,
      role: "HUMAN",
      text,
      externalId: messageId,
    },
  });
}

export async function purgeOldAssistantData(): Promise<number> {
  const { retentionDays } = getAssistantConfig();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  // De quien pidio que no le escribieran se borran los mensajes, pero se recuerda
  // su decision para no volver a escribirle.
  await prisma.assistantMessage.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      conversation: { status: "OPTED_OUT" },
    },
  });
  const { count } = await prisma.assistantConversation.deleteMany({
    where: { updatedAt: { lt: cutoff }, status: { not: "OPTED_OUT" } },
  });
  return count;
}
