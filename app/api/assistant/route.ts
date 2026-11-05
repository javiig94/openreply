import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  getAssistantConfig,
  isAssistantConfigured,
} from "@/lib/assistant/config";

const unauthorized = () =>
  NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const config = getAssistantConfig();
  const since = new Date(Date.now() - 24 * 3_600_000);
  const [settings, byStatus, tokens, repliesLastDay, conversations] =
    await Promise.all([
      prisma.assistantSettings.findUnique({ where: { workspaceId } }),
      prisma.assistantConversation.groupBy({
        by: ["status"],
        where: { workspaceId },
        _count: { _all: true },
      }),
      prisma.assistantConversation.aggregate({
        where: { workspaceId },
        _sum: { inputTokens: true, outputTokens: true, replyCount: true },
      }),
      prisma.assistantMessage.count({
        where: {
          role: "ASSISTANT",
          createdAt: { gte: since },
          conversation: { workspaceId },
        },
      }),
      prisma.assistantConversation.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: {
          id: true,
          username: true,
          status: true,
          stage: true,
          replyCount: true,
          handoffReason: true,
          updatedAt: true,
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { role: true, text: true },
          },
        },
      }),
    ]);

  return NextResponse.json({
    success: true,
    data: {
      enabled: settings?.enabled ?? false,
      configured: isAssistantConfigured(config),
      model: config.model,
      maxRepliesPerConversation: config.maxRepliesPerConversation,
      maxRepliesPerDay: config.maxRepliesPerDay,
      repliesLastDay,
      byStatus: Object.fromEntries(
        byStatus.map((row) => [row.status, row._count._all])
      ),
      tokens: {
        input: tokens._sum.inputTokens ?? 0,
        output: tokens._sum.outputTokens ?? 0,
      },
      conversations,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();

  const body = (await request.json().catch(() => null)) as {
    enabled?: unknown;
  } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json(
      { success: false, error: "enabled must be a boolean" },
      { status: 400 }
    );
  }

  const settings = await prisma.assistantSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, enabled: body.enabled },
    update: { enabled: body.enabled },
  });
  return NextResponse.json({
    success: true,
    data: { enabled: settings.enabled },
  });
}
