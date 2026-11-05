import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createReelContainer,
  getContainerStatus,
  getMediaPermalink,
  publishContainer,
} from "@/lib/meta/client";
import { getAuthorizationUrl } from "@/lib/meta/oauth";

function responde(cuerpo: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(cuerpo), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("llamadas a Instagram para publicar", () => {
  it("crea el contenedor de un reel", async () => {
    const fetchMock = responde({ id: "c1" });
    await expect(
      createReelContainer("tok", "ig1", {
        videoUrl: "https://x/a.mp4",
        caption: "hola",
        shareToFeed: true,
      })
    ).resolves.toEqual({ id: "c1" });
    const [url, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/ig1\/media$/);
    expect(opciones.method).toBe("POST");
    expect(JSON.parse(opciones.body as string)).toEqual({
      media_type: "REELS",
      video_url: "https://x/a.mp4",
      caption: "hola",
      share_to_feed: true,
    });
    // La clave viaja en la cabecera, nunca en la direccion.
    expect(url).not.toContain("tok");
    expect((opciones.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("un trial reel lleva sus parámetros y no se comparte en el perfil", async () => {
    const fetchMock = responde({ id: "c2" });
    await createReelContainer("tok", "ig1", {
      videoUrl: "https://x/b.mp4",
      caption: "hola",
      shareToFeed: true,
      trialGraduation: "SS_PERFORMANCE",
    });
    const [, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(opciones.body as string)).toEqual({
      media_type: "REELS",
      video_url: "https://x/b.mp4",
      caption: "hola",
      trial_params: { graduation_strategy: "SS_PERFORMANCE" },
    });
  });

  it("una historia solo manda el vídeo", async () => {
    const fetchMock = responde({ id: "c4" });
    await createReelContainer("tok", "ig1", {
      videoUrl: "https://x/h.mp4",
      caption: "no debe ir",
      shareToFeed: true,
      coverUrl: "https://x/h.jpg",
      isStory: true,
    });
    const [, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(opciones.body as string)).toEqual({
      media_type: "STORIES",
      video_url: "https://x/h.mp4",
    });
  });

  it("añade la portada y la etiqueta de IA cuando toca", async () => {
    const fetchMock = responde({ id: "c3" });
    await createReelContainer("tok", "ig1", {
      videoUrl: "https://x/c.mp4",
      caption: "",
      shareToFeed: true,
      coverUrl: "https://x/c.jpg",
      isAiGenerated: true,
    });
    const [, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(opciones.body as string)).toMatchObject({
      cover_url: "https://x/c.jpg",
      is_ai_generated: true,
      share_to_feed: true,
    });
  });

  it("pregunta el estado del contenedor", async () => {
    const fetchMock = responde({ status_code: "FINISHED" });
    await expect(getContainerStatus("tok", "c1")).resolves.toEqual({
      status_code: "FINISHED",
    });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain(
      "/c1?fields=status_code,status"
    );
  });

  it("publica con el id del contenedor", async () => {
    const fetchMock = responde({ id: "m1" });
    await expect(publishContainer("tok", "ig1", "c1")).resolves.toEqual({ id: "m1" });
    const [url, opciones] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/ig1\/media_publish$/);
    expect(JSON.parse(opciones.body as string)).toEqual({ creation_id: "c1" });
  });

  it("devuelve el enlace, o nada si no viene", async () => {
    responde({ permalink: "https://i/r" });
    await expect(getMediaPermalink("tok", "m1")).resolves.toBe("https://i/r");
    responde({});
    await expect(getMediaPermalink("tok", "m1")).resolves.toBeNull();
  });

  it("un error de Instagram se lanza, no se da por bueno", async () => {
    responde({ error: { message: "no", code: 100 } }, 400);
    await expect(publishContainer("tok", "ig1", "c1")).rejects.toThrow("no");
  });
});

describe("permisos", () => {
  it("al conectar se pide también publicar", () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "123");
    const url = new URL(getAuthorizationUrl("https://x/cb", "estado"));
    const permisos = url.searchParams.get("scope")?.split(",") ?? [];
    expect(permisos).toEqual(
      expect.arrayContaining([
        "instagram_business_basic",
        "instagram_business_manage_messages",
        "instagram_business_manage_comments",
        "instagram_business_manage_insights",
        "instagram_business_content_publish",
      ])
    );
  });
});
