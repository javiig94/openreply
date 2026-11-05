import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  getPublishingConfig,
  listAvailableVideos,
  validateSchedule,
  videoUrlFor,
} from "@/lib/publishing/service";

const unauthorized = () =>
  NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const config = getPublishingConfig();
  const [accounts, videos, posts] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true },
    }),
    listAvailableVideos(config.videosDir),
    prisma.scheduledPost.findMany({
      where: { workspaceId },
      orderBy: { scheduledAt: "desc" },
      take: 100,
      select: {
        id: true,
        videoFile: true,
        caption: true,
        scheduledAt: true,
        trialGraduation: true,
        status: true,
        permalink: true,
        errorMessage: true,
        instagramAccount: { select: { username: true } },
      },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      configured: Boolean(config.baseUrl),
      maxPerDay: config.maxPerDay,
      accounts,
      videos: videos.map((video) => ({
        ...video,
        url: config.baseUrl ? videoUrlFor(config.baseUrl, video.file) : null,
      })),
      posts,
    },
  });
}

export async function POST(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const config = getPublishingConfig();
  const videos = await listAvailableVideos(config.videosDir);
  const parsed = validateSchedule(
    body,
    videos.map((video) => video.file)
  );
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: parsed.error },
      { status: 400 }
    );
  }

  const account = await prisma.instagramAccount.findFirst({
    where: {
      workspaceId,
      ...(typeof body?.instagramAccountId === "string"
        ? { id: body.instagramAccountId }
        : {}),
    },
    orderBy: { connectedAt: "desc" },
    select: { id: true },
  });
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Conecta primero la cuenta de Instagram." },
      { status: 400 }
    );
  }

  // El mismo reel no se programa dos veces, ni por un doble clic.
  const repeated = await prisma.scheduledPost.findFirst({
    where: {
      instagramAccountId: account.id,
      videoFile: parsed.value.videoFile,
      status: {
        in: ["SCHEDULED", "PROCESSING", "PUBLISHING", "PUBLISHED", "UNCONFIRMED"],
      },
    },
    select: { status: true },
  });
  if (repeated) {
    return NextResponse.json(
      {
        success: false,
        error: "Este vídeo ya está programado o publicado en esta cuenta.",
      },
      { status: 409 }
    );
  }

  try {
    const post = await prisma.scheduledPost.create({
      data: {
        workspaceId,
        instagramAccountId: account.id,
        ...parsed.value,
      },
      select: { id: true },
    });
    return NextResponse.json({ success: true, data: post }, { status: 201 });
  } catch (error) {
    // Dos envios a la vez: el indice unico de la base de datos deja pasar solo uno.
    if ((error as { code?: string }).code === "P2002") {
      return NextResponse.json(
        {
          success: false,
          error: "Este vídeo ya está programado o publicado en esta cuenta.",
        },
        { status: 409 }
      );
    }
    throw error;
  }
}
