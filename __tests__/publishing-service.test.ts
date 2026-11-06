import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { mockPrisma, mockMeta, mockEmail } = vi.hoisted(() => ({
  mockPrisma: {
    scheduledPost: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
  },
  mockMeta: {
    createReelContainer: vi.fn(),
    getContainerStatus: vi.fn(),
    publishContainer: vi.fn(),
    getMediaPermalink: vi.fn(),
  },
  mockEmail: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(async () => ({
    provider: "META",
    accessToken: "token",
  })),
  hasInstagramCredentials: vi.fn(() => true),
}));
vi.mock("@/lib/instagram/delivery-errors", () => ({
  isConfirmedSendRejection: (error: unknown) =>
    (error as { rejected?: boolean }).rejected === true,
}));
vi.mock("@/lib/meta/client", () => ({
  ...mockMeta,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/assistant/notify", () => ({ sendOwnerEmail: mockEmail }));

import {
  isValidVideoName,
  publishDuePosts,
  removePublishedFiles,
  validateSchedule,
  videoUrlFor,
} from "@/lib/publishing/service";

const NOW = new Date("2026-11-10T18:00:00Z");

function post(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    videoFile: "A.mp4",
    caption: "texto",
    shareToFeed: true,
    scheduledAt: new Date(NOW.getTime() - 60_000),
    status: "SCHEDULED",
    attempts: 0,
    containerId: null,
    containerCreatedAt: null,
    instagramAccount: { instagramId: "ig1", provider: "META" },
    ...over,
  };
}

/** Lo que devuelve la base de datos segun el estado que se pida. */
function enCola(...posts: Array<ReturnType<typeof post>>) {
  mockPrisma.scheduledPost.findMany.mockImplementation(
    async ({ where }: { where: { status: string } }) =>
      posts.filter((candidate) => candidate.status === where.status)
  );
}

/** Los cambios de estado finales, sin contar las reservas de cada vuelta. */
const estados = () =>
  [
    ...mockPrisma.scheduledPost.update.mock.calls,
    ...mockPrisma.scheduledPost.updateMany.mock.calls,
  ]
    .map((call) => call[0].data.status)
    .filter((status) => status && status !== "PROCESSING" && status !== "PUBLISHING");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLISH_VIDEOS_BASE_URL = "https://guia.example.com/reels";
  process.env.PUBLISH_MAX_PER_DAY = "5";
  process.env.ALLOWED_EMAILS = "dueno@example.com";
  mockPrisma.scheduledPost.count.mockResolvedValue(0);
  mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.scheduledPost.update.mockResolvedValue({});
  mockMeta.createReelContainer.mockResolvedValue({ id: "c1" });
  mockMeta.getContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
  mockMeta.publishContainer.mockResolvedValue({ id: "m1" });
  mockMeta.getMediaPermalink.mockResolvedValue("https://instagram.com/reel/x");
  mockEmail.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("empezar", () => {
  it("publica como historia lo que se programó así", async () => {
    enCola(post({ mediaKind: "STORY" }));
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1",
      expect.objectContaining({ isStory: true })
    );
  });

  it("publica como trial reel lo que se programó así", async () => {
    enCola(post({ trialGraduation: "SS_PERFORMANCE" }));
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1",
      expect.objectContaining({ trialGraduation: "SS_PERFORMANCE" })
    );
  });

  it("usa la portada si hay una imagen con el mismo nombre", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(null, {
        status: 200,
        headers: { "content-type": url.endsWith(".jpg") ? "image/jpeg" : "video/mp4" },
      })
    ));
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1",
      expect.objectContaining({ coverUrl: "https://guia.example.com/reels/A.jpg" })
    );
  });

  it("ignora una página que no sea una imagen como portada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(null, { status: 200, headers: { "content-type": "text/html" } })
    ));
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1",
      expect.objectContaining({ coverUrl: null })
    );
  });

  it("permite apagar la etiqueta de IA desde la configuración", async () => {
    process.env.PUBLISH_AI_LABEL = "false";
    enCola(post());
    await publishDuePosts(NOW);
    delete process.env.PUBLISH_AI_LABEL;
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1",
      expect.objectContaining({ isAiGenerated: false })
    );
  });

  it("crea el contenedor con la dirección pública y no publica todavía", async () => {
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).toHaveBeenCalledWith("token", "ig1", {
      videoUrl: "https://guia.example.com/reels/A.mp4",
      caption: "texto",
      shareToFeed: true,
      trialGraduation: null,
      coverUrl: null,
      isAiGenerated: true,
      isStory: false,
    });
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
    const guardado = mockPrisma.scheduledPost.updateMany.mock.calls.find(
      (call) => call[0].data.containerId === "c1"
    );
    expect(guardado?.[0].where.status).toBe("PROCESSING");
  });

  it("si otra vuelta ya la reservó, no hace nada", async () => {
    enCola(post());
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 0 });
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
  });

  it("sin dirección de vídeos configurada no hace nada", async () => {
    delete process.env.PUBLISH_VIDEOS_BASE_URL;
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockPrisma.scheduledPost.findMany).not.toHaveBeenCalled();
  });

  it("respeta el máximo diario", async () => {
    mockPrisma.scheduledPost.count.mockResolvedValue(5);
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
  });

  it("no pide más de los que caben en el máximo", async () => {
    mockPrisma.scheduledPost.count.mockResolvedValue(3);
    enCola(post());
    await publishDuePosts(NOW);
    const llamada = mockPrisma.scheduledPost.findMany.mock.calls.find(
      (call) => call[0].where.status === "SCHEDULED"
    );
    expect(llamada?.[0].take).toBe(2);
  });

  it("si se pasó la hora por mucho, no lo publica tarde y avisa", async () => {
    enCola(post({ scheduledAt: new Date(NOW.getTime() - 7 * 3_600_000) }));
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
    expect(estados()).toEqual(["FAILED"]);
    expect(mockEmail).toHaveBeenCalled();
  });

  it("si el reel ya cambió de estado, no lo marca como fallido ni avisa", async () => {
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 0 });
    enCola(post({ scheduledAt: new Date(NOW.getTime() - 7 * 3_600_000) }));
    await publishDuePosts(NOW);
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it("si el vídeo no se puede abrir, lo reintenta sin crear contenedor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    enCola(post());
    await publishDuePosts(NOW);
    expect(mockMeta.createReelContainer).not.toHaveBeenCalled();
    expect(estados()).toEqual(["SCHEDULED"]);
  });

  it("un fallo pasajero vuelve a la cola, y tras muchos intentos avisa", async () => {
    mockMeta.createReelContainer.mockRejectedValue(new Error("red"));
    enCola(post());
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["SCHEDULED"]);
    expect(mockEmail).not.toHaveBeenCalled();

    mockPrisma.scheduledPost.update.mockClear();
    mockPrisma.scheduledPost.updateMany.mockClear();
    enCola(post({ attempts: 9 }));
    await publishDuePosts(NOW);
    expect(estados()).toContain("FAILED");
    expect(mockEmail).toHaveBeenCalled();
  });

  it("un rechazo claro no se reintenta", async () => {
    mockMeta.createReelContainer.mockRejectedValue(
      Object.assign(new Error("sin permiso"), { rejected: true })
    );
    enCola(post());
    await publishDuePosts(NOW);
    expect(estados()).toContain("FAILED");
  });
});

describe("publicar: un reel nunca sale dos veces", () => {
  const procesando = (over: Record<string, unknown> = {}) =>
    post({
      status: "PROCESSING",
      containerId: "c1",
      containerCreatedAt: new Date(NOW.getTime() - 120_000),
      ...over,
    });

  it("con el vídeo listo publica una vez y guarda el enlace", async () => {
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).toHaveBeenCalledTimes(1);
    expect(mockMeta.publishContainer).toHaveBeenCalledWith("token", "ig1", "c1");
    const datos = mockPrisma.scheduledPost.update.mock.calls[0][0].data;
    expect(datos).toMatchObject({
      status: "PUBLISHED",
      mediaId: "m1",
      permalink: "https://instagram.com/reel/x",
    });
  });

  it("con el vídeo listo pero muchas horas tarde, no lo publica y avisa", async () => {
    enCola(procesando({ scheduledAt: new Date(NOW.getTime() - 7 * 3_600_000) }));
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
    expect(estados()).toEqual(["FAILED"]);
    expect(mockEmail).toHaveBeenCalled();
  });

  it("una llamada colgada no resucita un reel que ya ha cambiado de estado", async () => {
    mockMeta.createReelContainer.mockRejectedValue(new Error("colgado"));
    enCola(post());
    await publishDuePosts(NOW);
    const vuelta = mockPrisma.scheduledPost.updateMany.mock.calls.find(
      (call) => call[0].data.status === "SCHEDULED"
    );
    expect(vuelta?.[0].where.status).toBe("PROCESSING");
    expect(mockPrisma.scheduledPost.update).not.toHaveBeenCalled();
  });

  it("si otra vuelta ya está publicando, no publica", async () => {
    enCola(procesando());
    mockPrisma.scheduledPost.updateMany.mockResolvedValue({ count: 0 });
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
  });

  it("si aún se procesa, espera", async () => {
    mockMeta.getContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
    expect(estados()).toEqual([]);
  });

  it("si tarda demasiado, falla y avisa", async () => {
    mockMeta.getContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });
    enCola(procesando({ containerCreatedAt: new Date(NOW.getTime() - 31 * 60_000) }));
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["FAILED"]);
    expect(mockEmail).toHaveBeenCalled();
  });

  it.each(["ERROR", "EXPIRED"])("si Instagram da %s, falla y avisa", async (code) => {
    mockMeta.getContainerStatus.mockResolvedValue({ status_code: code, status: "motivo" });
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["FAILED"]);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
  });

  it("si Instagram dice que ya está publicado, no lo vuelve a publicar", async () => {
    mockMeta.getContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
    expect(estados()).toEqual(["PUBLISHED"]);
  });

  it("si la orden de publicar falla sin saber por qué, no reintenta y avisa", async () => {
    mockMeta.publishContainer.mockRejectedValue(new Error("red caída"));
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["UNCONFIRMED"]);
    expect(mockEmail).toHaveBeenCalled();
    // La siguiente vuelta ya no la ve como pendiente de publicar.
    expect(mockMeta.publishContainer).toHaveBeenCalledTimes(1);
  });

  it("si Instagram la rechaza claramente, queda como no publicada", async () => {
    mockMeta.publishContainer.mockRejectedValue(
      Object.assign(new Error("no"), { rejected: true })
    );
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["FAILED"]);
  });

  it("si no se consigue el enlace, sigue contando como publicado", async () => {
    mockMeta.getMediaPermalink.mockRejectedValue(new Error("x"));
    enCola(procesando());
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["PUBLISHED"]);
  });

  it("si se cortó justo al publicar, queda sin confirmar y no se reintenta", async () => {
    enCola(post({ status: "PUBLISHING", containerId: "c1" }));
    await publishDuePosts(NOW);
    expect(estados()).toEqual(["UNCONFIRMED"]);
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
    expect(mockEmail).toHaveBeenCalled();
  });

  it("si se cortó antes de crear el contenedor, vuelve a la cola: no salió nada", async () => {
    enCola(
      procesando({
        containerId: null,
        containerCreatedAt: new Date(NOW.getTime() - 6 * 60_000),
      })
    );
    await publishDuePosts(NOW);
    expect(mockPrisma.scheduledPost.updateMany.mock.calls[0][0].data.status).toBe(
      "SCHEDULED"
    );
    expect(mockMeta.publishContainer).not.toHaveBeenCalled();
  });

  it("un fallo con un reel no frena a los demás", async () => {
    mockMeta.getContainerStatus
      .mockRejectedValueOnce(new Error("uno"))
      .mockResolvedValueOnce({ status_code: "FINISHED" });
    enCola(procesando({ id: "p1" }), procesando({ id: "p2" }));
    await publishDuePosts(NOW);
    expect(mockMeta.publishContainer).toHaveBeenCalledTimes(1);
  });
});

describe("borrar del servidor lo ya publicado", () => {
  let dir: string;
  const hay = (nombre: string) => existsSync(path.join(dir, nombre));
  const crea = (...nombres: string[]) => nombres.forEach((n) => writeFileSync(path.join(dir, n), "x"));

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "reels-"));
    process.env.PUBLISH_VIDEOS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.PUBLISH_VIDEOS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("borra el vídeo, su portada y su texto, y deja los demás", async () => {
    crea("A.mp4", "A.jpg", "A.txt", "B.mp4", "B.jpg", "B.txt");
    mockPrisma.scheduledPost.findMany.mockResolvedValue([{ videoFile: "A.mp4" }]);
    await removePublishedFiles(dir);
    expect(["A.mp4", "A.jpg", "A.txt"].some(hay)).toBe(false);
    expect(["B.mp4", "B.jpg", "B.txt"].every(hay)).toBe(true);
    const consulta = mockPrisma.scheduledPost.findMany.mock.calls[0][0];
    expect(consulta.where.status).toBe("PUBLISHED");
  });

  it("no falla si falta la portada", async () => {
    crea("A.mp4");
    mockPrisma.scheduledPost.findMany.mockResolvedValue([{ videoFile: "A.mp4" }]);
    await expect(removePublishedFiles(dir)).resolves.toBeUndefined();
    expect(hay("A.mp4")).toBe(false);
  });

  it("no falla si la carpeta no existe", async () => {
    await expect(removePublishedFiles(path.join(dir, "no-existe"))).resolves.toBeUndefined();
    expect(mockPrisma.scheduledPost.findMany).not.toHaveBeenCalled();
  });

  it("cada vuelta de la cola borra lo publicado", async () => {
    crea("A.mp4", "A.jpg");
    enCola(post({ status: "PUBLISHED" }));
    await publishDuePosts(NOW);
    expect(hay("A.mp4")).toBe(false);
    expect(hay("A.jpg")).toBe(false);
  });

  it.each(["SCHEDULED", "PROCESSING", "FAILED", "UNCONFIRMED", "CANCELLED"])(
    "no borra un vídeo en estado %s",
    async (status) => {
      crea("A.mp4", "A.jpg", "A.txt");
      enCola(post({ status, scheduledAt: new Date(NOW.getTime() + 3_600_000) }));
      await publishDuePosts(NOW);
      expect(["A.mp4", "A.jpg", "A.txt"].every(hay)).toBe(true);
    }
  );
});

describe("datos del panel", () => {
  const disponibles = ["A.mp4"];
  const futuro = "2026-11-11T18:00:00.000Z";

  it("acepta lo correcto", () => {
    const resultado = validateSchedule(
      { videoFile: "A.mp4", caption: " hola ", scheduledAt: futuro },
      disponibles,
      NOW
    );
    expect(resultado).toMatchObject({
      ok: true,
      value: { caption: "hola", shareToFeed: true, trialGraduation: null, mediaKind: "REEL" },
    });
  });

  it("acepta una historia", () => {
    const resultado = validateSchedule(
      { videoFile: "A.mp4", scheduledAt: futuro, mediaKind: "STORY" },
      disponibles,
      NOW
    );
    expect(resultado).toMatchObject({ ok: true, value: { mediaKind: "STORY" } });
  });

  it("acepta un trial reel", () => {
    const resultado = validateSchedule(
      { videoFile: "A.mp4", scheduledAt: futuro, trialGraduation: "MANUAL" },
      disponibles,
      NOW
    );
    expect(resultado).toMatchObject({ ok: true, value: { trialGraduation: "MANUAL" } });
  });

  it.each([
    ["vídeo que no existe", { videoFile: "B.mp4", scheduledAt: futuro }],
    ["salir de la carpeta", { videoFile: "../secreto.mp4", scheduledAt: futuro }],
    ["sin fecha", { videoFile: "A.mp4" }],
    ["historia y trial a la vez", { videoFile: "A.mp4", scheduledAt: futuro, mediaKind: "STORY", trialGraduation: "MANUAL" }],
    ["trial reel inventado", { videoFile: "A.mp4", scheduledAt: futuro, trialGraduation: "OTRO" }],
    ["fecha pasada", { videoFile: "A.mp4", scheduledAt: "2026-11-01T00:00:00Z" }],
    ["texto larguísimo", { videoFile: "A.mp4", scheduledAt: futuro, caption: "x".repeat(2201) }],
    ["demasiados hashtags", { videoFile: "A.mp4", scheduledAt: futuro, caption: "#a ".repeat(31) }],
  ])("rechaza %s", (_nombre, cuerpo) => {
    expect(validateSchedule(cuerpo, disponibles, NOW).ok).toBe(false);
  });

  it.each(["A-dolor.mp4", "reel_1.mp4"])("nombre válido: %s", (nombre) => {
    expect(isValidVideoName(nombre)).toBe(true);
  });

  it.each(["../x.mp4", "a b.mp4", "x.txt", ".mp4", "a/b.mp4", "a..b.mp4"])(
    "nombre no válido: %s",
    (nombre) => {
      expect(isValidVideoName(nombre)).toBe(false);
    }
  );

  it("construye la dirección", () => {
    expect(videoUrlFor("https://x.com/reels", "A-1.mp4")).toBe(
      "https://x.com/reels/A-1.mp4"
    );
  });
});
