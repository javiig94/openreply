import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const {
  mockPrisma,
  mockQueueAdd,
  mockSendDirectMessage,
  mockSendSenderAction,
  mockChat,
  mockNotify,
} = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    assistantConversation: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    assistantMessage: {
      deleteMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    automation: { findMany: vi.fn() },
    dmLog: { findFirst: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockQueueAdd: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendSenderAction: vi.fn(),
  mockChat: vi.fn(),
  mockNotify: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  ASSISTANT_REPLY_JOB_NAME: "assistant-reply",
  ASSISTANT_REMINDER_JOB_NAME: "assistant-reminder",
}));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(async () => ({
    provider: "META",
    accessToken: "x",
  })),
  hasInstagramCredentials: vi.fn(() => true),
  resolveRecipientName: vi.fn(async () => "ana"),
  sendDirectMessage: mockSendDirectMessage,
  sendSenderAction: mockSendSenderAction,
}));
vi.mock("@/lib/instagram/delivery-errors", () => ({
  isConfirmedSendRejection: (error: unknown) =>
    (error as { rejected?: boolean }).rejected === true,
  classifySendError: (error: unknown) => error,
}));
vi.mock("@/lib/assistant/llm", () => ({
  createChat: () => mockChat,
}));
vi.mock("@/lib/assistant/knowledge", () => ({
  loadKnowledge: vi.fn(async () => ({
    ficha: "f",
    guion: "g",
    normas: "n",
    ejemplos: "e",
  })),
}));
vi.mock("@/lib/assistant/notify", () => ({ notifyHandoff: mockNotify }));
// Sin esperas reales en las pruebas.
vi.mock("@/lib/assistant/timing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/timing")>()),
  typingMs: () => 0,
}));

import {
  assistantOnCampaignDelivered,
  assistantOnInboundMessage,
  assistantOwnsConversation,
  processAssistantEcho,
  processAssistantReminder,
  processAssistantReply,
  purgeOldAssistantData,
  looksLikeCampaignText,
} from "@/lib/assistant/service";
import {
  DISCLOSURE_TEXT,
  LIMIT_TEXT,
  MINOR_TEXT,
  OPT_OUT_TEXT,
  REMINDER_TEXT,
  REMINDER_WITH_DISCLOSURE_TEXT,
} from "@/lib/assistant/engine";

const ACCOUNT = {
  id: "acc",
  workspaceId: "ws",
  instagramId: "ig1",
  workspace: { assistantSettings: { enabled: true } },
};

function conversation(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    workspaceId: "ws",
    igUserId: "u1",
    username: "ana",
    status: "ACTIVE",
    stage: null,
    pausedUntil: null,
    disclosedAt: null,
    reminderSentAt: null,
    replyCount: 0,
    lastUserMessageAt: new Date(),
    instagramAccount: ACCOUNT,
    ...over,
  };
}

const replyJob = (attemptsMade = 0) =>
  ({
    data: {
      instagramAccountId: "ig1",
      conversationId: "c1",
      triggerMessageId: "m1",
    },
    opts: { attempts: 3 },
    attemptsMade,
  }) as unknown as Job<never>;

const respuestaIA = (mensajes: string[], accion = "responder") => ({
  content: JSON.stringify({ accion, mensajes, etapa: "ayuda", motivo: "m" }),
  inputTokens: 10,
  outputTokens: 5,
});

const enviados = () =>
  mockSendDirectMessage.mock.calls.map(
    (call) => (call[0] as { message: string }).message
  );

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ASSISTANT_API_KEY = "clave-de-prueba";
  mockPrisma.instagramAccount.findUnique.mockResolvedValue(ACCOUNT);
  mockPrisma.assistantConversation.findUnique.mockResolvedValue(conversation());
  mockPrisma.assistantConversation.upsert.mockResolvedValue(conversation());
  mockPrisma.assistantMessage.findUnique.mockResolvedValue(null);
  mockPrisma.assistantMessage.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      where.role === "USER" ? { id: "m1" } : null
  );
  mockPrisma.assistantMessage.findMany.mockResolvedValue([
    { role: "USER", text: "hola" },
  ]);
  mockPrisma.assistantMessage.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: data.role === "USER" ? "m1" : "out",
    })
  );
  mockPrisma.assistantMessage.update.mockResolvedValue({});
  mockPrisma.assistantMessage.count.mockResolvedValue(0);
  mockPrisma.automation.findMany.mockResolvedValue([]);
  mockPrisma.dmLog.findFirst.mockResolvedValue({ commentId: "comentario" });
  mockSendDirectMessage.mockResolvedValue({ message_id: "mid-out" });
  mockSendSenderAction.mockResolvedValue(undefined);
  mockChat.mockResolvedValue(respuestaIA(["Vale. ¿Tienes tema?"]));
});

describe("el interruptor manda", () => {
  it("apagado: no anota ni programa nada", async () => {
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      ...ACCOUNT,
      workspace: { assistantSettings: { enabled: false } },
    });
    await assistantOnInboundMessage({
      instagramId: "ig1",
      igUserId: "u1",
      messageId: "mid",
      text: "hola",
      handledByCampaign: false,
    });
    expect(mockPrisma.assistantMessage.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("sin clave real tampoco actúa", async () => {
    process.env.ASSISTANT_API_KEY = "PENDIENTE_IA";
    await assistantOnInboundMessage({
      instagramId: "ig1",
      igUserId: "u1",
      messageId: "mid",
      text: "hola",
      handledByCampaign: false,
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("se apaga mientras esperaba: el trabajo no envía nada", async () => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({
        instagramAccount: {
          ...ACCOUNT,
          workspace: { assistantSettings: { enabled: false } },
        },
      })
    );
    await processAssistantReply(replyJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("un fallo del asistente no rompe las campañas", () => {
  it("los ganchos no lanzan errores", async () => {
    mockPrisma.instagramAccount.findUnique.mockRejectedValue(new Error("bd caída"));
    await expect(
      assistantOnInboundMessage({
        instagramId: "ig1",
        igUserId: "u1",
        messageId: "mid",
        text: "hola",
        handledByCampaign: false,
      })
    ).resolves.toBeUndefined();
    await expect(
      assistantOnCampaignDelivered({
        instagramId: "ig1",
        igUserId: "u1",
        username: null,
        text: "t",
        openedByUser: true,
      })
    ).resolves.toBeUndefined();
    await expect(assistantOwnsConversation("ig1", "u1")).resolves.toBe(false);
  });
});

describe("mensaje entrante", () => {
  const entrada = (handledByCampaign = false) =>
    assistantOnInboundMessage({
      instagramId: "ig1",
      igUserId: "u1",
      messageId: "mid",
      text: "hola",
      handledByCampaign,
    });

  it("programa la respuesta con espera y el recordatorio", async () => {
    await entrada();
    const nombres = mockQueueAdd.mock.calls.map((call) => call[0]);
    expect(nombres).toEqual(["assistant-reminder", "assistant-reply"]);
    const opciones = mockQueueAdd.mock.calls[1][2] as { delay: number };
    expect(opciones.delay).toBeGreaterThanOrEqual(30_000);
    expect(opciones.delay).toBeLessThanOrEqual(90_000);
  });

  it("si lo atendió una campaña no contesta la IA, solo el recordatorio", async () => {
    await entrada(true);
    expect(mockQueueAdd.mock.calls.map((call) => call[0])).toEqual([
      "assistant-reminder",
    ]);
  });

  it("no procesa dos veces el mismo mensaje, pero vuelve a pedir la respuesta", async () => {
    mockPrisma.assistantMessage.findUnique.mockResolvedValue({
      id: "ya",
      conversationId: "c1",
    });
    await entrada();
    expect(mockPrisma.assistantMessage.create).not.toHaveBeenCalled();
    expect(mockQueueAdd.mock.calls.map((call) => call[0])).toEqual(["assistant-reply"]);
  });

  it("quien pidió que no le escribieran no vuelve con un mensaje suelto", async () => {
    mockPrisma.assistantConversation.upsert.mockResolvedValue(
      conversation({ status: "OPTED_OUT" })
    );
    await entrada();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.assistantConversation.update).not.toHaveBeenCalled();
  });

  it("sí vuelve si lo pide con la palabra de la campaña", async () => {
    mockPrisma.assistantConversation.upsert.mockResolvedValue(
      conversation({ status: "OPTED_OUT" })
    );
    await entrada(true);
    expect(mockPrisma.assistantConversation.update).toHaveBeenCalled();
    expect(mockQueueAdd.mock.calls.map((call) => call[0])).toEqual([
      "assistant-reminder",
    ]);
  });

  it("si la lleva una persona, solo lo anota", async () => {
    mockPrisma.assistantConversation.upsert.mockResolvedValue(
      conversation({ status: "HANDED_OFF" })
    );
    await entrada();
    expect(mockPrisma.assistantMessage.create).toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("pausa vigente: no contesta; pausa vencida: vuelve", async () => {
    mockPrisma.assistantConversation.upsert.mockResolvedValue(
      conversation({
        status: "PAUSED_HUMAN",
        pausedUntil: new Date(Date.now() + 60_000),
      })
    );
    await entrada();
    expect(mockQueueAdd).not.toHaveBeenCalled();

    mockPrisma.assistantConversation.upsert.mockResolvedValue(
      conversation({
        status: "PAUSED_HUMAN",
        pausedUntil: new Date(Date.now() - 60_000),
      })
    );
    await entrada();
    expect(mockQueueAdd).toHaveBeenCalled();
    expect(mockPrisma.assistantConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "ACTIVE", pausedUntil: null },
      })
    );
  });
});

describe("responder", () => {
  it("la primera vez avisa de que es una IA, antes de nada", async () => {
    await processAssistantReply(replyJob());
    expect(enviados()).toEqual([DISCLOSURE_TEXT, "Vale. ¿Tienes tema?"]);
    const datos = mockPrisma.assistantConversation.update.mock.calls.map(
      (call) => call[0].data
    );
    expect(datos.some((d) => d.disclosedAt instanceof Date)).toBe(true);
  });

  it("no repite el aviso", async () => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({ disclosedAt: new Date() })
    );
    await processAssistantReply(replyJob());
    expect(enviados()).toEqual(["Vale. ¿Tienes tema?"]);
  });

  it("si ha llegado otro mensaje después, responde solo el último", async () => {
    mockPrisma.assistantMessage.findFirst.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.role === "USER" ? { id: "m2" } : null
    );
    await processAssistantReply(replyJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("no contesta dos veces al mismo mensaje", async () => {
    mockPrisma.assistantMessage.findFirst.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) =>
        where.role === "USER" ? { id: "m1" } : { id: "contestado" }
    );
    await processAssistantReply(replyJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("fuera de las 24 h no escribe", async () => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({
        lastUserMessageAt: new Date(Date.now() - 25 * 3_600_000),
      })
    );
    await processAssistantReply(replyJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("respeta el tope diario", async () => {
    mockPrisma.assistantMessage.count.mockResolvedValue(100_000);
    await processAssistantReply(replyJob());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalled();
  });

  it("quien pide que no le escriban no pasa por la IA", async () => {
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      { role: "USER", text: "no me escribas más" },
    ]);
    await processAssistantReply(replyJob());
    expect(mockChat).not.toHaveBeenCalled();
    expect(enviados()).toEqual([OPT_OUT_TEXT]);
    expect(
      mockPrisma.assistantConversation.update.mock.calls[0][0].data.status
    ).toBe("OPTED_OUT");
  });

  it("un menor no pasa por la IA y avisa a una persona", async () => {
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      { role: "USER", text: "tengo 15 años" },
    ]);
    await processAssistantReply(replyJob());
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled();
  });

  it("junta los mensajes seguidos para las decisiones fijas", async () => {
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      // Como los devuelve la base de datos: del mas nuevo al mas viejo.
      { role: "USER", text: "no me escribas más" },
      { role: "USER", text: "hola" },
      { role: "ASSISTANT", text: "x" },
    ]);
    await processAssistantReply(replyJob());
    expect(enviados()).toEqual([OPT_OUT_TEXT]);
  });

  it("pasar a persona avisa por correo y deja de contestar", async () => {
    mockChat.mockResolvedValue(
      respuestaIA(["Se lo paso al equipo."], "pasar_a_persona")
    );
    await processAssistantReply(replyJob());
    expect(mockNotify).toHaveBeenCalled();
    const estados = mockPrisma.assistantConversation.update.mock.calls.map(
      (call) => call[0].data.status
    );
    expect(estados).toContain("HANDED_OFF");
  });

  it("si la IA falla reintenta, y al último intento avisa sin enviar nada suyo", async () => {
    mockChat.mockRejectedValue(new Error("caída"));
    await expect(processAssistantReply(replyJob(0))).rejects.toThrow("caída");
    await processAssistantReply(replyJob(2));
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalled();
  });

  it("si Meta lo rechaza de forma explícita, retira la fila para poder reintentar", async () => {
    mockSendDirectMessage.mockRejectedValue(
      Object.assign(new Error("rechazado"), { rejected: true })
    );
    await expect(processAssistantReply(replyJob())).rejects.toThrow("rechazado");
    expect(mockPrisma.assistantMessage.delete).toHaveBeenCalled();
  });

  it("con cualquier otro fallo no se sabe si salió: conserva la fila para no repetir", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("red caída"));
    await expect(processAssistantReply(replyJob())).rejects.toThrow("red caída");
    expect(mockPrisma.assistantMessage.delete).not.toHaveBeenCalled();
  });

  it("si sale bien pero falla al anotarlo, no lo da por fallido", async () => {
    mockPrisma.assistantMessage.update.mockRejectedValue(new Error("bd"));
    await expect(processAssistantReply(replyJob())).resolves.toBeUndefined();
    expect(mockPrisma.assistantMessage.delete).not.toHaveBeenCalled();
    expect(enviados()).toHaveLength(2);
  });

  it("el estado se fija antes de enviar: si falla el envío, no le llega nada más", async () => {
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      { role: "USER", text: "no me escribas más" },
    ]);
    mockSendDirectMessage.mockRejectedValue(new Error("red caída"));
    await expect(processAssistantReply(replyJob())).rejects.toThrow("red caída");
    expect(
      mockPrisma.assistantConversation.update.mock.calls[0][0].data.status
    ).toBe("OPTED_OUT");
  });

  it("el aviso no cuenta como respuesta: si falla lo siguiente, se contesta sin repetirlo", async () => {
    mockSendDirectMessage
      .mockResolvedValueOnce({ message_id: "aviso" })
      .mockRejectedValueOnce(Object.assign(new Error("no"), { rejected: true }));
    await expect(processAssistantReply(replyJob())).rejects.toThrow("no");
    const creadas = mockPrisma.assistantMessage.create.mock.calls.map(
      (call) => call[0].data
    );
    expect(creadas[0]).toMatchObject({ text: DISCLOSURE_TEXT, inReplyToId: null });
    expect(creadas[1]).toMatchObject({ inReplyToId: "m1" });
  });

  it("un menor o el límite también avisan de que es una IA si es lo primero", async () => {
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      { role: "USER", text: "tengo 15 años" },
    ]);
    await processAssistantReply(replyJob());
    expect(enviados()).toEqual([DISCLOSURE_TEXT, MINOR_TEXT]);

    vi.clearAllMocks();
    mockSendDirectMessage.mockResolvedValue({ message_id: "x" });
    mockPrisma.assistantMessage.findMany.mockResolvedValue([
      { role: "USER", text: "hola" },
    ]);
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({ replyCount: 99, disclosedAt: new Date() })
    );
    await processAssistantReply(replyJob());
    expect(enviados()).toEqual([LIMIT_TEXT]);
  });

  it("si falla el 'escribiendo...' el mensaje sale igual", async () => {
    mockSendSenderAction.mockRejectedValue(new Error("no soportado"));
    await processAssistantReply(replyJob());
    expect(enviados()).toHaveLength(2);
  });
});

describe("recordatorio", () => {
  const anchor = new Date(Date.now() - 20 * 3_600_000);
  const job = () =>
    ({
      data: {
        instagramAccountId: "ig1",
        conversationId: "c1",
        anchorMs: anchor.getTime(),
      },
    }) as unknown as Job<never>;

  it("si ya sabe que es una IA, va el recordatorio normal", async () => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({ lastUserMessageAt: anchor, disclosedAt: new Date() })
    );
    await processAssistantReminder(job());
    expect(enviados()).toEqual([REMINDER_TEXT]);
  });

  it("si es lo primero que le escribe, dice que es una IA", async () => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({ lastUserMessageAt: anchor })
    );
    await processAssistantReminder(job());
    expect(enviados()).toEqual([REMINDER_WITH_DISCLOSURE_TEXT]);
    expect(
      mockPrisma.assistantConversation.update.mock.calls[0][0].data.disclosedAt
    ).toBeInstanceOf(Date);
  });

  it.each([
    ["ha vuelto a escribir", { lastUserMessageAt: new Date() }],
    ["ya se envió", { lastUserMessageAt: anchor, reminderSentAt: new Date() }],
    ["no quiere mensajes", { lastUserMessageAt: anchor, status: "OPTED_OUT" }],
    ["lo lleva una persona", { lastUserMessageAt: anchor, status: "HANDED_OFF" }],
  ])("no se envía si %s", async (_nombre, over) => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation(over)
    );
    await processAssistantReminder(job());
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("no se envía fuera de las 24 h", async () => {
    const viejo = new Date(Date.now() - 24.5 * 3_600_000);
    mockPrisma.assistantConversation.findUnique.mockResolvedValue(
      conversation({ lastUserMessageAt: viejo })
    );
    await processAssistantReminder({
      data: {
        instagramAccountId: "ig1",
        conversationId: "c1",
        anchorMs: viejo.getTime(),
      },
    } as unknown as Job<never>);
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("reconocer el texto de una campaña", () => {
  it("con el nombre al principio, en medio o sin él", () => {
    const plantillas = ["{username}, aquí tienes la guía para tu canal"];
    expect(looksLikeCampaignText("Ana, aquí tienes la guía para tu canal", plantillas)).toBe(true);
    expect(looksLikeCampaignText("Hola, soy Javi, te cuento", plantillas)).toBe(false);
  });

  it("aunque el enlace se haya quitado o cambiado", () => {
    expect(
      looksLikeCampaignText("Toma la guía aquí mismo", [
        "Toma la guía aquí mismo https://guia.marketnextia.com",
      ])
    ).toBe(true);
  });

  it("un texto muy corto no basta para decidir", () => {
    expect(looksLikeCampaignText("ok vale", ["ok"])).toBe(false);
  });
});

describe("limpieza de datos antiguos", () => {
  it("conserva la decisión de quien no quiere mensajes", async () => {
    mockPrisma.assistantConversation.deleteMany.mockResolvedValue({ count: 1 });
    await purgeOldAssistantData();
    expect(
      mockPrisma.assistantConversation.deleteMany.mock.calls[0][0].where.status
    ).toEqual({ not: "OPTED_OUT" });
    expect(mockPrisma.assistantMessage.deleteMany).toHaveBeenCalled();
  });
});

describe("eco: quién ha escrito lo que sale de la cuenta", () => {
  const eco = (text: string) =>
    ({
      data: {
        instagramAccountId: "ig1",
        recipientId: "u1",
        messageId: "mid-eco",
        text,
      },
    }) as unknown as Job<never>;

  beforeEach(() => {
    mockPrisma.assistantConversation.findUnique.mockResolvedValue({ id: "c1" });
    mockPrisma.assistantConversation.upsert.mockResolvedValue({ id: "c1" });
    mockPrisma.assistantMessage.findFirst.mockResolvedValue(null);
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        dmMessage: "Aquí tienes la guía {username}: enlace",
        openingDmMessage: "¿Te paso la guía?",
        followUpMessage: null,
        followPromptMessage: null,
      },
    ]);
  });

  it("si escribe una persona, el asistente se aparta", async () => {
    await processAssistantEcho(eco("Hola, soy Javi, te cuento"));
    expect(mockPrisma.assistantConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "PAUSED_HUMAN" }),
      })
    );
  });

  it("su propio mensaje no le hace apartarse", async () => {
    mockPrisma.assistantMessage.findFirst.mockResolvedValue({ id: "propio" });
    await processAssistantEcho(eco("Vale. ¿Tienes tema?"));
    expect(mockPrisma.assistantConversation.upsert).not.toHaveBeenCalled();
  });

  it("el mensaje de una campaña tampoco, aunque lleve el nombre", async () => {
    await processAssistantEcho(eco("Aquí tienes la guía ana: enlace"));
    await processAssistantEcho(eco("¿Te paso la guía?"));
    expect(mockPrisma.assistantConversation.upsert).not.toHaveBeenCalled();
  });
});
