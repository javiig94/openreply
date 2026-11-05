"use client";

/**
 * Panel de publicacion: elegir video, texto y fecha, y ver lo programado.
 * Esta en espanol a proposito, igual que la pantalla del asistente.
 */

import { useCallback, useEffect, useState } from "react";

type Status =
  | "SCHEDULED"
  | "PROCESSING"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED"
  | "CANCELLED"
  | "UNCONFIRMED";

interface Video {
  file: string;
  caption: string;
  url: string | null;
}

interface Post {
  id: string;
  videoFile: string;
  caption: string;
  scheduledAt: string;
  status: Status;
  permalink: string | null;
  errorMessage: string | null;
  instagramAccount: { username: string };
}

interface Overview {
  configured: boolean;
  maxPerDay: number;
  accounts: Array<{ id: string; username: string }>;
  videos: Video[];
  posts: Post[];
}

const STATUS_LABELS: Record<Status, string> = {
  SCHEDULED: "Programado",
  PROCESSING: "Instagram lo está procesando",
  PUBLISHING: "Publicando",
  PUBLISHED: "Publicado",
  FAILED: "No se ha publicado",
  CANCELLED: "Cancelado",
  UNCONFIRMED: "Sin confirmar: míralo en Instagram",
};

const inputClass =
  "mt-1 w-full rounded border border-border bg-transparent px-3 py-2 text-sm";

export default function PublishingPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [videoFile, setVideoFile] = useState("");
  const [caption, setCaption] = useState("");
  const [when, setWhen] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/publishing");
    if (!response.ok) {
      setLoadError("No se ha podido cargar la publicación.");
      return;
    }
    const body = (await response.json()) as { data: Overview };
    setOverview(body.data);
    setLoadError(null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function chooseVideo(file: string) {
    setVideoFile(file);
    setCaption(overview?.videos.find((video) => video.file === file)?.caption ?? "");
  }

  async function schedule(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSaving(true);
    const response = await fetch("/api/publishing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoFile,
        caption,
        // La fecha se escribe en la hora del navegador de Javi.
        scheduledAt: when ? new Date(when).toISOString() : "",
      }),
    });
    setSaving(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      setFormError(body?.error ?? "No se ha podido programar.");
      return;
    }
    setVideoFile("");
    setCaption("");
    setWhen("");
    await load();
  }

  async function act(id: string, action: "cancel" | "not_published") {
    await fetch(`/api/publishing/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await load();
  }

  if (loadError) return <p className="text-sm text-red-500">{loadError}</p>;
  if (!overview) return <p className="text-sm text-muted">Cargando…</p>;

  const selected = overview.videos.find((video) => video.file === videoFile);

  return (
    <div className="space-y-6">
      <form onSubmit={(event) => void schedule(event)} className="panel rounded p-6">
        <h2 className="text-lg font-semibold">Programar un reel</h2>
        {!overview.configured && (
          <p className="mt-2 text-sm text-red-500">
            Falta configurar la dirección de los vídeos en el servidor.
          </p>
        )}
        {overview.accounts.length === 0 && (
          <p className="mt-2 text-sm text-red-500">
            Conecta primero la cuenta de Instagram en Settings.
          </p>
        )}
        {overview.videos.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            Aún no hay vídeos en el servidor. Se suben con INSTALAR OPENREPLY.
          </p>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <label className="block text-sm font-semibold">
              Vídeo
              <select
                value={videoFile}
                onChange={(event) => chooseVideo(event.target.value)}
                className={inputClass}
                required
              >
                <option value="">Elige uno</option>
                {overview.videos.map((video) => (
                  <option key={video.file} value={video.file}>
                    {video.file}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold">
              Texto
              <textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                className={inputClass}
                rows={7}
                maxLength={2200}
              />
            </label>
            <label className="block text-sm font-semibold">
              Fecha y hora
              <input
                type="datetime-local"
                value={when}
                onChange={(event) => setWhen(event.target.value)}
                className={inputClass}
                required
              />
            </label>
            {formError && <p className="text-sm text-red-500">{formError}</p>}
            <button
              type="submit"
              disabled={saving || overview.accounts.length === 0}
              className="rounded border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              Programar
            </button>
            <p className="text-xs text-muted">
              Como máximo se publican {overview.maxPerDay} reels en 24 horas.
            </p>
          </div>
          {selected?.url && (
            <video
              key={selected.url}
              src={selected.url}
              controls
              preload="metadata"
              className="max-h-[480px] w-full rounded bg-black"
            />
          )}
        </div>
      </form>

      <div className="panel overflow-hidden rounded">
        <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">
          Calendario
        </h3>
        {overview.posts.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted">Todavía no hay nada programado.</p>
        )}
        <ul className="divide-y divide-border">
          {overview.posts.map((post) => (
            <li key={post.id} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{post.videoFile}</span>
                <span className="text-xs text-muted">{STATUS_LABELS[post.status]}</span>
              </div>
              <p className="mt-1 text-xs text-muted">
                {new Date(post.scheduledAt).toLocaleString("es-ES", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}{" "}
                · @{post.instagramAccount.username}
              </p>
              {post.errorMessage && (
                <p className="mt-1 text-xs text-red-500">{post.errorMessage}</p>
              )}
              <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold">
                {post.permalink && (
                  <a href={post.permalink} target="_blank" rel="noreferrer" className="underline">
                    Ver en Instagram
                  </a>
                )}
                {post.status === "SCHEDULED" && (
                  <button type="button" onClick={() => void act(post.id, "cancel")} className="underline">
                    Cancelar
                  </button>
                )}
                {post.status === "UNCONFIRMED" && (
                  <button type="button" onClick={() => void act(post.id, "not_published")} className="underline">
                    Lo he mirado: no salió
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
