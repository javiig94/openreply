/**
 * Lee el entrenamiento del asistente: cuatro ficheros de texto que viven fuera de
 * la imagen, en el servidor. Cambiarlos no obliga a fabricar nada: se releen solos.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Knowledge } from "./engine";

const FILES = {
  ficha: "ficha.md",
  guion: "guion.md",
  normas: "normas.md",
  ejemplos: "ejemplos.md",
} as const;

let cache: { key: string; knowledge: Knowledge } | null = null;

export async function loadKnowledge(dir: string): Promise<Knowledge> {
  const entries = Object.entries(FILES) as Array<[keyof Knowledge, string]>;
  const stats = await Promise.all(
    entries.map(([, file]) => stat(path.join(dir, file)))
  );
  const key = `${dir}:${stats.map((entry) => entry.mtimeMs).join(",")}`;
  if (cache?.key === key) return cache.knowledge;

  const contents = await Promise.all(
    entries.map(([, file]) => readFile(path.join(dir, file), "utf8"))
  );
  const knowledge = Object.fromEntries(
    entries.map(([name], index) => [name, contents[index].trim()])
  ) as unknown as Knowledge;
  cache = { key, knowledge };
  return knowledge;
}
