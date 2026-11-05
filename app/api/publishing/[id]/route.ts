import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

/**
 * "cancel": anula un reel que aun no ha empezado a publicarse.
 * "not_published": Javi ha mirado Instagram y un reel dudoso no salio. Asi se
 * puede volver a programar.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    action?: unknown;
  } | null;

  const change =
    body?.action === "cancel"
      ? { from: "SCHEDULED" as const, to: "CANCELLED" as const, message: null }
      : body?.action === "not_published"
        ? {
            from: "UNCONFIRMED" as const,
            to: "FAILED" as const,
            message: "Comprobado a mano: no se publicó.",
          }
        : null;
  if (!change) {
    return NextResponse.json(
      { success: false, error: "Invalid action" },
      { status: 400 }
    );
  }

  const { count } = await prisma.scheduledPost.updateMany({
    where: { id, workspaceId, status: change.from },
    data: { status: change.to, errorMessage: change.message },
  });
  if (count === 0) {
    return NextResponse.json(
      { success: false, error: "Ya no se puede cambiar." },
      { status: 409 }
    );
  }
  return NextResponse.json({ success: true, data: { status: change.to } });
}
