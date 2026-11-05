"use client";

/**
 * Panel del asistente: interruptor, numeros y conversaciones.
 * Esta en espanol a proposito: es la unica pantalla que Javi necesita a diario.
 */

import { useCallback, useEffect, useState } from "react";

type Status = "ACTIVE" | "PAUSED_HUMAN" | "HANDED_OFF" | "OPTED_OUT" | "CLOSED";
type Role = "USER" | "ASSISTANT" | "AUTOMATION" | "HUMAN";

interface ConversationRow {
  id: string;
  username: string | null;
  status: Status;
  stage: string | null;
  replyCount: number;
  handoffReason: string | null;
  updatedAt: string;
  messages: Array<{ role: Role; text: string }>;
}

interface Overview {
  enabled: boolean;
  configured: boolean;
  model: string;
  maxRepliesPerConversation: number;
  maxRepliesPerDay: number;
  repliesLastDay: number;
  byStatus: Partial<Record<Status, number>>;
  tokens: { input: number; output: number };
  conversations: ConversationRow[];
}

interface Detail {
  id: string;
  username: string | null;
  status: Status;
  handoffReason: string | null;
  messages: Array<{ id: string; role: Role; text: string; createdAt: string }>;
}

const STATUS_LABELS: Record<Status, string> = {
  ACTIVE: "Con el asistente",
  PAUSED_HUMAN: "Has contestado tú",
  HANDED_OFF: "Necesita a una persona",
  OPTED_OUT: "No quiere mensajes",
  CLOSED: "Terminada",
};

const ROLE_LABELS: Record<Role, string> = {
  USER: "Persona",
  ASSISTANT: "Asistente",
  AUTOMATION: "Campaña",
  HUMAN: "Tú",
};

const number = (value: number) => value.toLocaleString("es-ES");

export default function AssistantPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/assistant");
    if (!response.ok) {
      setError("No se ha podido cargar el asistente.");
      return;
    }
    const body = (await response.json()) as { data: Overview };
    setOverview(body.data);
    setError(null);
  }, []);

  const openConversation = useCallback(async (id: string) => {
    const response = await fetch(`/api/assistant/${id}`);
    if (!response.ok) {
      setError("No se ha podido abrir la conversación.");
      return;
    }
    const body = (await response.json()) as { data: Detail };
    setDetail(body.data);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function toggle() {
    if (!overview) return;
    setSaving(true);
    await fetch("/api/assistant", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !overview.enabled }),
    });
    await load();
    setSaving(false);
  }

  async function changeStatus(id: string, status: "ACTIVE" | "HANDED_OFF") {
    await fetch(`/api/assistant/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await Promise.all([load(), openConversation(id)]);
  }

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!overview) return <p className="text-sm text-muted">Cargando…</p>;

  const needPerson = overview.byStatus.HANDED_OFF ?? 0;

  return (
    <div className="space-y-6">
      <div className="panel rounded p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {overview.enabled ? "El asistente está encendido" : "El asistente está apagado"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {overview.enabled
                ? "Contesta solo a los mensajes privados, dentro de las 24 horas que permite Meta."
                : "Las campañas siguen funcionando. Nadie recibe respuestas de la IA."}
            </p>
            {!overview.configured && (
              <p className="mt-2 text-sm text-red-500">
                Falta la clave de la IA en el servidor: aunque lo enciendas, no contestará.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={saving}
            className="rounded border border-border px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {overview.enabled ? "Apagar" : "Encender"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Necesitan a una persona", number(needPerson)],
          ["Con el asistente", number(overview.byStatus.ACTIVE ?? 0)],
          [
            "Mensajes en 24 h",
            `${number(overview.repliesLastDay)} de ${number(overview.maxRepliesPerDay)}`,
          ],
          [
            "Consumo de IA",
            `${number(overview.tokens.input + overview.tokens.output)} tokens`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="panel rounded p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</p>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="panel overflow-hidden rounded">
          <h3 className="border-b border-border px-4 py-3 text-sm font-semibold">
            Conversaciones
          </h3>
          {overview.conversations.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted">Todavía no hay ninguna.</p>
          )}
          <ul className="divide-y divide-border">
            {overview.conversations.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => void openConversation(row.id)}
                  className="w-full px-4 py-3 text-left hover:bg-black/5"
                >
                  <span className="flex items-center justify-between gap-2 text-sm font-semibold">
                    <span>{row.username ? `@${row.username}` : "Sin nombre"}</span>
                    <span className="text-xs font-normal text-muted">
                      {STATUS_LABELS[row.status]}
                    </span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-muted">
                    {row.messages[0]?.text ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel rounded p-4">
          {!detail && (
            <p className="text-sm text-muted">Elige una conversación para leerla.</p>
          )}
          {detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {detail.username ? `@${detail.username}` : "Sin nombre"} ·{" "}
                  {STATUS_LABELS[detail.status]}
                </h3>
                {detail.status === "OPTED_OUT" ? null : detail.status === "ACTIVE" ? (
                  <button
                    type="button"
                    onClick={() => void changeStatus(detail.id, "HANDED_OFF")}
                    className="rounded border border-border px-3 py-1 text-xs font-semibold"
                  >
                    La llevo yo
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void changeStatus(detail.id, "ACTIVE")}
                    className="rounded border border-border px-3 py-1 text-xs font-semibold"
                  >
                    Devolver al asistente
                  </button>
                )}
              </div>
              {detail.handoffReason && (
                <p className="text-xs text-muted">Motivo: {detail.handoffReason}</p>
              )}
              <ul className="space-y-3">
                {detail.messages.map((message) => (
                  <li key={message.id}>
                    <p className="text-xs font-semibold text-muted">
                      {ROLE_LABELS[message.role]}
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{message.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
