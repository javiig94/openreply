/**
 * Cola de reels programados.
 *
 * Instagram publica en dos tiempos: primero descarga y procesa el video
 * (contenedor) y luego se ordena publicarlo. Cada publicacion avanza un paso por
 * vuelta, asi el proceso no se queda esperando.
 *
 * Regla de construccion: un reel nunca sale dos veces. Si Instagram no confirma
 * la publicacion, se marca como UNCONFIRMED, no se reintenta y se avisa a Javi.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
} from "@/lib/instagram/provider";
import { isConfirmedSendRejection } from "@/lib/instagram/delivery-errors";
import {
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  publishContainer,
  RateLimitError,
} from "@/lib/meta/client";
import { sendOwnerEmail } from "@/lib/assistant/notify";

const MINUTE = 60_000;
/** Instagram tarda en procesar: pasado este tiempo se da por fallido. */
const CONTAINER_TIMEOUT_MS = 30 * MINUTE;
/** Sin respuesta tras ordenar publicar: no se sabe si salio. */
const PUBLISHING_STALE_MS = 5 * MINUTE;
/** Mejor no publicar que soltar un reel horas despues de su momento. */
const MAX_LATE_MS = 6 * 60 * MINUTE;
const MAX_START_ATTEMPTS = 10;
const CAPTION_MAX = 2200;
const HASHTAGS_MAX = 30;
const VIDEO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/;

export interface PublishingConfig {
  videosDir: string;
  baseUrl: string;
  maxPerDay: number;
  notifyEmail: string | null;
}

export function getPublishingConfig(
  env: Record<string, string | undefined> = process.env
): PublishingConfig {
  const max = Number(env.PUBLISH_MAX_PER_DAY);
  return {
    videosDir: env.PUBLISH_VIDEOS_DIR ?? path.join(process.cwd(), "reels"),
    baseUrl: (env.PUBLISH_VIDEOS_BASE_URL ?? "").replace(/\/+$/, ""),
    maxPerDay: Number.isFinite(max) && max > 0 ? Math.floor(max) : 5,
    notifyEmail:
      env.ASSISTANT_NOTIFY_EMAIL ??
      (env.ALLOWED_EMAILS ?? "").split(",")[0]?.trim() ??
      null,
  };
}

/** Evita salir de la carpeta y nombres que rompan la direccion del video. */
export function isValidVideoName(name: string): boolean {
  return VIDEO_NAME.test(name) && !name.includes("..");
}

export function videoUrlFor(baseUrl: string, file: string): string {
  return `${baseUrl}/${encodeURIComponent(file)}`;
}

export interface AvailableVideo {
  file: string;
  caption: string;
}

/** Los videos subidos. Si hay un .txt con el mismo nombre, es su texto propuesto. */
export async function listAvailableVideos(
  videosDir: string
): Promise<AvailableVideo[]> {
  let names: string[];
  try {
    names = await readdir(videosDir);
  } catch {
    return [];
  }
  const files = names.filter(isValidVideoName).sort();
  return Promise.all(
    files.map(async (file) => {
      const caption = await readFile(
        path.join(videosDir, file.replace(/\.mp4$/, ".txt")),
        "utf8"
      ).catch(() => "");
      return { file, caption: caption.trim() };
    })
  );
}

export type ScheduleInput = {
  videoFile: string;
  caption: string;
  scheduledAt: Date;
  shareToFeed: boolean;
};

/** Comprueba lo que llega del panel. Devuelve el motivo si no vale. */
export function validateSchedule(
  body: unknown,
  available: string[],
  now: Date = new Date()
): { ok: true; value: ScheduleInput } | { ok: false; error: string } {
  const data = (body ?? {}) as Record<string, unknown>;
  const videoFile = typeof data.videoFile === "string" ? data.videoFile : "";
  if (!isValidVideoName(videoFile) || !available.includes(videoFile)) {
    return { ok: false, error: "Ese vídeo no está en el servidor." };
  }
  const caption = typeof data.caption === "string" ? data.caption.trim() : "";
  if (caption.length > CAPTION_MAX) {
    return { ok: false, error: `El texto pasa de ${CAPTION_MAX} letras.` };
  }
  if ((caption.match(/#/g) ?? []).length > HASHTAGS_MAX) {
    return { ok: false, error: `Instagram admite ${HASHTAGS_MAX} hashtags como máximo.` };
  }
  const scheduledAt = new Date(String(data.scheduledAt ?? ""));
  if (Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, error: "Falta la fecha." };
  }
  if (scheduledAt.getTime() < now.getTime() - MINUTE) {
    return { ok: false, error: "Esa fecha ya ha pasado." };
  }
  return {
    ok: true,
    value: {
      videoFile,
      caption,
      scheduledAt,
      shareToFeed: data.shareToFeed !== false,
    },
  };
}

function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Error desconocido").slice(
    0,
    300
  );
}

type DuePost = Prisma.ScheduledPostGetPayload<{
  include: { instagramAccount: true };
}>;

async function accessTokenFor(post: DuePost): Promise<string> {
  const account = post.instagramAccount;
  if (!hasInstagramCredentials(account)) {
    throw new Error("La cuenta de Instagram no está conectada.");
  }
  const context = await createInstagramContext(account, `publish:${post.id}`);
  if (context.provider !== "META") {
    throw new Error("Publicar solo funciona con la conexión directa de Meta.");
  }
  return context.accessToken;
}

async function warn(
  config: PublishingConfig,
  post: Pick<DuePost, "videoFile">,
  problem: string
): Promise<void> {
  await sendOwnerEmail({
    to: config.notifyEmail,
    subject: `Problema al publicar ${post.videoFile}`,
    text: problem,
    linkPath: "/publishing",
  });
}

async function fail(
  config: PublishingConfig,
  post: DuePost,
  message: string
): Promise<void> {
  const { count } = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: { in: ["SCHEDULED", "PROCESSING"] } },
    data: { status: "FAILED", errorMessage: message },
  });
  if (count > 0) await warn(config, post, message);
}

async function startPost(
  post: DuePost,
  now: Date,
  config: PublishingConfig
): Promise<void> {
  if (now.getTime() - post.scheduledAt.getTime() > MAX_LATE_MS) {
    await fail(
      config,
      post,
      "Se pasó la hora de publicarlo y no se ha publicado. Prográmalo de nuevo."
    );
    return;
  }

  // Solo una vuelta puede quedarse con cada publicacion.
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "SCHEDULED" },
    data: { status: "PROCESSING", containerId: null, containerCreatedAt: now },
  });
  if (claimed.count === 0) return;

  try {
    const accessToken = await accessTokenFor(post);
    const videoUrl = videoUrlFor(config.baseUrl, post.videoFile);
    const head = await fetch(videoUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(30_000),
    });
    if (!head.ok) {
      throw new Error(`El vídeo no se puede abrir en ${videoUrl} (${head.status}).`);
    }
    const container = await createReelContainer(
      accessToken,
      post.instagramAccount.instagramId,
      {
        videoUrl,
        caption: post.caption,
        shareToFeed: post.shareToFeed,
      }
    );
    await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "PROCESSING" },
      data: { containerId: container.id },
    });
  } catch (error) {
    // Crear el contenedor no publica nada: reintentar aqui no puede duplicar.
    const permanent =
      isConfirmedSendRejection(error) && !(error instanceof RateLimitError);
    const attempts = post.attempts + 1;
    if (permanent || attempts >= MAX_START_ATTEMPTS) {
      await prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "PROCESSING" },
        data: { attempts },
      });
      await fail(config, post, describeError(error));
      return;
    }
    // Solo si sigue siendo suya: una llamada colgada no resucita un reel cancelado.
    await prisma.scheduledPost.updateMany({
      where: { id: post.id, status: "PROCESSING" },
      data: {
        status: "SCHEDULED",
        attempts,
        errorMessage: describeError(error),
      },
    });
  }
}

async function publishPost(
  post: DuePost,
  accessToken: string,
  config: PublishingConfig
): Promise<void> {
  const claimed = await prisma.scheduledPost.updateMany({
    where: { id: post.id, status: "PROCESSING" },
    data: { status: "PUBLISHING" },
  });
  if (claimed.count === 0) return;

  let mediaId: string;
  try {
    const published = await publishContainer(
      accessToken,
      post.instagramAccount.instagramId,
      post.containerId as string
    );
    mediaId = published.id;
  } catch (error) {
    const rejected = isConfirmedSendRejection(error);
    const message = rejected
      ? `Instagram lo ha rechazado: ${describeError(error)}`
      : `No se sabe si se ha publicado. Míralo en Instagram: no se reintenta para no duplicarlo. ${describeError(error)}`;
    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        status: rejected ? "FAILED" : "UNCONFIRMED",
        errorMessage: message,
      },
    });
    await warn(config, post, message);
    return;
  }

  const permalink = await getMediaPermalink(accessToken, mediaId).catch(
    () => null
  );
  await prisma.scheduledPost.update({
    where: { id: post.id },
    data: {
      status: "PUBLISHED",
      mediaId,
      permalink,
      publishedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function advanceProcessing(
  post: DuePost,
  now: Date,
  config: PublishingConfig
): Promise<void> {
  const age = now.getTime() - (post.containerCreatedAt ?? now).getTime();

  // Se corto entre reservarla y crear el contenedor: no se ha publicado nada.
  if (!post.containerId) {
    if (age > PUBLISHING_STALE_MS) {
      await prisma.scheduledPost.updateMany({
        where: { id: post.id, status: "PROCESSING", containerId: null },
        data: { status: "SCHEDULED", attempts: { increment: 1 } },
      });
    }
    return;
  }

  let accessToken: string;
  let statusCode: string | undefined;
  let statusText: string | undefined;
  try {
    accessToken = await accessTokenFor(post);
    const status = await getContainerStatus(accessToken, post.containerId);
    statusCode = status.status_code;
    statusText = status.status;
  } catch (error) {
    if (age > CONTAINER_TIMEOUT_MS) {
      await fail(config, post, describeError(error));
    }
    return;
  }

  switch (statusCode) {
    case "FINISHED":
      if (now.getTime() - post.scheduledAt.getTime() > MAX_LATE_MS) {
        await fail(
          config,
          post,
          "Se pasó la hora de publicarlo y no se ha publicado. Prográmalo de nuevo."
        );
        return;
      }
      await publishPost(post, accessToken, config);
      return;
    case "PUBLISHED":
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      return;
    case "ERROR":
    case "EXPIRED":
      await fail(
        config,
        post,
        `Instagram no ha podido procesar el vídeo: ${statusText ?? statusCode}`
      );
      return;
    default:
      if (age > CONTAINER_TIMEOUT_MS) {
        await fail(config, post, "Instagram ha tardado demasiado en procesar el vídeo.");
      }
  }
}

async function guarded(where: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`[Publishing] ${where}: ${describeError(error)}`);
  }
}

/** Una vuelta de la cola. La lanza el proceso de envios cada minuto. */
export async function publishDuePosts(now: Date = new Date()): Promise<void> {
  const config = getPublishingConfig();
  if (!config.baseUrl) return;

  // Se corto justo despues de ordenar publicar: pudo salir o no.
  const stale = await prisma.scheduledPost.findMany({
    where: {
      status: "PUBLISHING",
      updatedAt: { lt: new Date(now.getTime() - PUBLISHING_STALE_MS) },
    },
    include: { instagramAccount: true },
  });
  for (const post of stale) {
    await guarded("stale", async () => {
      const message =
        "No se sabe si se ha publicado. Míralo en Instagram: no se reintenta para no duplicarlo.";
      await prisma.scheduledPost.update({
        where: { id: post.id },
        data: { status: "UNCONFIRMED", errorMessage: message },
      });
      await warn(config, post, message);
    });
  }

  const processing = await prisma.scheduledPost.findMany({
    where: { status: "PROCESSING" },
    include: { instagramAccount: true },
    orderBy: { scheduledAt: "asc" },
  });
  for (const post of processing) {
    await guarded("processing", () => advanceProcessing(post, now, config));
  }

  const used = await prisma.scheduledPost.count({
    where: {
      OR: [
        {
          status: "PUBLISHED",
          publishedAt: { gte: new Date(now.getTime() - 24 * 60 * MINUTE) },
        },
        { status: { in: ["PROCESSING", "PUBLISHING"] } },
      ],
    },
  });
  const room = config.maxPerDay - used;
  if (room <= 0) return;

  const due = await prisma.scheduledPost.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    include: { instagramAccount: true },
    orderBy: { scheduledAt: "asc" },
    take: room,
  });
  for (const post of due) {
    await guarded("start", () => startPost(post, now, config));
  }
}
