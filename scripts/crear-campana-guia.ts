/**
 * Crea o actualiza la campana GUIA de la cuenta conectada. Se puede repetir.
 * Si todavia no hay cuenta de Instagram conectada, avisa y no hace nada.
 *
 *   npx tsx scripts/crear-campana-guia.ts
 */
import { prisma } from "@/lib/db/client";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

const NOMBRE = "GUIA";
const ENLACE_GUIA = "https://guia.marketnextia.com";

const CAMPANA = {
  name: NOMBRE,
  goal: "Enviar la guia a quien comenta GUIA o escribe info",
  matchAnyPost: true,
  pendingNextReel: false,
  postId: null,
  postUrl: null,
  // Los acentos y las mayusculas dan igual: "GUÍA", "guia" y "quiero la guía" valen.
  keywords: ["guia", "info", "informacion"],
  wholeWordMatch: true,
  matchAnyWord: false,
  dmTriggerEnabled: true,
  openingDmEnabled: true,
  openingDmMessage:
    "Hola {username}. Has comentado en el reel. ¿Te paso la guía para montar tu canal de YouTube con IA?",
  openingDmButtonLabel: "Sí, pásamela",
  dmMessage:
    "Aquí la tienes. Son 7 pasos, con los textos listos para copiar en la IA.\n\n¿Empiezas de cero o ya tienes canal?",
  linkButtonLabel: "Abrir la guía",
  requireFollow: false,
  followUpEnabled: false,
  publicReplyEnabled: true,
  publicReplyMessage: "Te lo acabo de enviar por privado 📩",
  publicReplyMessages: [
    "Te lo acabo de enviar por privado 📩",
    "Enviado, míralo en tus mensajes",
    "Hecho, ya lo tienes en tus mensajes privados",
    "Ya te lo he mandado. Si no lo ves, mira en Solicitudes de mensajes",
    "Enviado 📩 Si no te aparece, mira en Solicitudes",
  ],
  isActive: true,
};

async function main() {
  const cuenta = await prisma.instagramAccount.findFirst({
    orderBy: { connectedAt: "desc" },
  });
  if (!cuenta) {
    console.log("Campaña GUIA: aún no hay cuenta de Instagram conectada, no se crea nada.");
    return;
  }

  const existente = await prisma.automation.findFirst({
    where: { instagramAccountId: cuenta.id, name: NOMBRE },
    include: { trackedLinks: true },
  });

  if (existente) {
    await prisma.automation.update({
      where: { id: existente.id },
      data: CAMPANA,
    });
    console.log(`Campaña GUIA actualizada para @${cuenta.username}.`);
    return;
  }

  await prisma.automation.create({
    data: {
      ...CAMPANA,
      workspaceId: cuenta.workspaceId,
      instagramAccountId: cuenta.id,
      trackedLinks: {
        create: [
          {
            workspaceId: cuenta.workspaceId,
            slug: generateTrackedLinkSlug(),
            label: "Abrir la guía",
            destinationUrl: ENLACE_GUIA,
            position: 0,
          },
        ],
      },
    },
  });
  console.log(`Campaña GUIA creada para @${cuenta.username}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
