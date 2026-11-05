import { describe, it, expect } from "vitest";
import {
  checkMessages,
  cleanMessage,
  hasHardViolation,
  isOptOut,
  saysIsMinor,
} from "@/lib/assistant/guardrails";

const context = {
  lastUserText: "hola",
  allowedDomains: ["guia.marketnextia.com", "marketnextia.com"],
};

const codes = (messages: string[], over: Partial<typeof context> = {}) =>
  checkMessages(messages, { ...context, ...over }).map((v) => v.code);

describe("filtro del asistente: normas duras", () => {
  it("deja pasar un mensaje normal", () => {
    expect(codes(["Vale. ¿Empiezas de cero o ya tienes canal?"])).toEqual([]);
  });

  it.each([
    "Tranquilo, soy una persona",
    "Te lo digo yo, que soy humano",
    "No soy un bot, de verdad",
    "no soy una IA",
    "Soy Javi, el fundador",
  ])("rechaza que diga que es una persona: %s", (text) => {
    expect(codes([text])).toContain("claims_human");
  });

  it("permite avisar de que una persona del equipo contestara", () => {
    expect(codes(["Esto lo ve una persona del equipo y te contesta."])).toEqual(
      []
    );
  });

  it.each([
    "Con esto vas a ganar mucho",
    "ganarás dinero desde el primer mes",
    "Es dinero fácil",
    "Se hace sin esfuerzo",
    "Tienes ingresos garantizados",
    "Te garantizo resultados",
    "En 30 días estás cobrando",
  ])("rechaza promesas de ingresos: %s", (text) => {
    expect(codes([text])).toContain("income_promise");
  });

  it("permite decir que no se garantiza nada", () => {
    expect(codes(["No te garantizamos ingresos, depende de tu trabajo."])).toEqual(
      []
    );
  });

  it.each(["1.000 € al mes", "500 euros", "$300", "3000 dólares"])(
    "rechaza importes inventados: %s",
    (text) => {
      expect(codes([`Puedes llegar a ${text}`])).toContain("money_amount");
    }
  );

  it("permite el precio real", () => {
    expect(codes(["Son 39,99 € en un solo pago."])).toEqual([]);
  });

  it.each(["Quedan pocas plazas", "Son las últimas plazas", "Solo hoy", "quedan 3"])(
    "rechaza urgencia inventada: %s",
    (text) => {
      expect(codes([text])).toContain("false_scarcity");
    }
  );

  it("permite decir que solo hay 50 plazas", () => {
    expect(codes(["Solo hay 50 plazas."])).toEqual([]);
  });

  it.each([
    "Mira https://bit.ly/abc",
    "Entra en www.otraweb.com",
    "Está en hotmart.com/x",
    "https://marketnextia.com.evil.io/a",
  ])("rechaza enlaces ajenos: %s", (text) => {
    expect(codes([text])).toContain("link_not_allowed");
  });

  it.each([
    "La guía: https://guia.marketnextia.com",
    "Apúntate en https://marketnextia.com/empieza",
    "Está en marketnextia.com",
  ])("permite los enlaces propios: %s", (text) => {
    expect(codes([text])).toEqual([]);
  });

  it("exige admitir que es una IA si lo preguntan", () => {
    expect(
      codes(["Te ayudo con lo que necesites."], { lastUserText: "¿eres un bot?" })
    ).toContain("must_admit_ai");
    expect(
      codes(["Sí, soy el asistente de MarketNext y contesto con IA."], {
        lastUserText: "pero eres un bot?",
      })
    ).not.toContain("must_admit_ai");
  });

  it("no enseña sus instrucciones", () => {
    expect(codes(["Según mis instrucciones no puedo"])).toContain("prompt_leak");
  });

  it("no envía mensajes vacíos ni más de dos", () => {
    expect(codes([])).toContain("empty");
    expect(codes(["a", "b", "c"])).toContain("too_many_messages");
    expect(codes(["x".repeat(601)])).toContain("too_long");
  });
});

describe("filtro del asistente: estilo", () => {
  it.each([
    ["¡Excelente pregunta! Mira", "ai_tell"],
    ["No dudes en preguntar", "ai_tell"],
    ["No es un curso, es un sistema", "ai_tell"],
    ["**Paso 1**", "markdown"],
    ["- primero\n- segundo", "markdown"],
    ["Vale — seguimos", "em_dash"],
    ["¡Genial! Cuéntame", "salesy_opening"],
    ["¿Tienes canal? ¿Y tema?", "too_many_questions"],
    ["Vale 😀😀", "too_many_emojis"],
  ])("avisa de: %s", (text, code) => {
    const violations = checkMessages([text], context);
    expect(violations.map((v) => v.code)).toContain(code);
    expect(hasHardViolation(violations)).toBe(false);
  });
});

describe("limpieza automatica", () => {
  it.each([
    ["¡Genial! Cuéntame más", "Cuéntame más"],
    ["Perfecto, vamos al paso 1", "Vamos al paso 1"],
    ["Qué bien. ¿Tienes tema?", "¿Tienes tema?"],
    ["Mira *esto* y **esto**", "Mira esto y esto"],
    ["Vale — seguimos", "Vale, seguimos"],
  ])("%s", (entrada, salida) => {
    expect(cleanMessage(entrada)).toBe(salida);
  });

  it("no toca un mensaje normal", () => {
    expect(cleanMessage("Perfecto para empezar es el paso 1")).toBe(
      "Perfecto para empezar es el paso 1"
    );
  });
});

describe("decisiones que no pasan por la IA", () => {
  it.each(["no me escribas más", "Déjame en paz", "STOP", "baja", "deja de escribirme"])(
    "detecta que no quieren mensajes: %s",
    (text) => {
      expect(isOptOut(text)).toBe(true);
    }
  );

  it.each(["no sé por dónde empezar", "cómo me doy de alta", "la bajada de vistas"])(
    "no confunde: %s",
    (text) => {
      expect(isOptOut(text)).toBe(false);
    }
  );

  it.each(["tengo 15 años", "Tengo 17", "cumplí 16"])("detecta menores: %s", (text) => {
    expect(saysIsMinor(text)).toBe(true);
  });

  it.each(["tengo 25 años", "tengo 18", "tengo 2 canales"])(
    "no confunde con adultos: %s",
    (text) => {
      expect(saysIsMinor(text)).toBe(false);
    }
  );
});
