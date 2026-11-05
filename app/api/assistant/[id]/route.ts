import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

const unauthorized = () =>
  NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
const notFound = () =>
  NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();
  const { id } = await params;

  const conversation = await prisma.assistantConversation.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      username: true,
      status: true,
      handoffReason: true,
      messages: {
        // Los mas recientes, y se devuelven en orden de lectura.
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, role: true, text: true, createdAt: true },
      },
    },
  });
  if (!conversation) return notFound();
  return NextResponse.json({
    success: true,
    data: { ...conversation, messages: [...conversation.messages].reverse() },
  });
}

/** "ACTIVE" devuelve la conversacion al asistente; "HANDED_OFF" se la quita. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return unauthorized();
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as {
    status?: unknown;
  } | null;
  if (body?.status !== "ACTIVE" && body?.status !== "HANDED_OFF") {
    return NextResponse.json(
      { success: false, error: "Invalid status" },
      { status: 400 }
    );
  }

  // A quien pidio que no le escribieran no se le reactiva desde el panel.
  const { count } = await prisma.assistantConversation.updateMany({
    where: {
      id,
      workspaceId,
      ...(body.status === "ACTIVE" ? { status: { not: "OPTED_OUT" as const } } : {}),
    },
    data:
      body.status === "ACTIVE"
        ? { status: "ACTIVE", pausedUntil: null, handoffReason: null }
        : { status: "HANDED_OFF", handoffReason: "Decisión manual" },
  });
  if (count === 0) return notFound();
  return NextResponse.json({ success: true, data: { status: body.status } });
}
