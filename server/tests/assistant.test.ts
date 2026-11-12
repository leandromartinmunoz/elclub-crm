import { PGlite } from "@electric-sql/pglite";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { ensureFirstAdmin, hashPassword } from "../src/lib/auth.js";
import { claudeDeps } from "../src/lib/assistant/claude.js";
import { clearDictionaryCache, deps as toolDeps } from "../src/lib/assistant/tools.js";

let server: Server, base: string, pg: PGlite;

function pgliteDb(pg: PGlite): Db {
  const run = (q: any) => async (sql: string, params?: unknown[]) =>
    !params?.length && sql.includes(";") ? { rows: ((await q.exec(sql)).at(-1)?.rows ?? []) as any[] }
      : { rows: (await q.query(sql, params)).rows as any[] };
  return { query: run(pg), transaction: work => pg.transaction(tx => work({ query: run(tx) })) };
}

class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method, headers: { "content-type": "application/json", cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }
  static async login(username: string, password: string) {
    const client = new Client();
    await client.call("POST", "/api/auth/login", { username, password });
    return client;
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

beforeAll(async () => {
  process.env.ADMIN_USERNAME = "leandro";
  process.env.ADMIN_PASSWORD = "clave-segura-123";
  pg = new PGlite();
  const db = pgliteDb(pg);
  setDb(db);
  await migrate(db);
  await ensureFirstAdmin();
  const pw = await hashPassword("otra-clave-123");
  await db.query(`INSERT INTO users(username,name,role,password_hash) VALUES
    ('caro','Carolina Paz','vendedor',$1),('recep','Recepción','recepcion',$1)`, [pw]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await pg.close(); });

let claudeCalls: any[], appCalls: { url: string; auth: string }[];
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "clave-falsa";
  process.env.MAIN_APP_URL = "https://app.ejemplo.com";
  process.env.MAIN_APP_TOKEN = "token-app";
  claudeCalls = []; appCalls = []; clearDictionaryCache();
  toolDeps.mainAppRequest = async (url, init) => {
    appCalls.push({ url, auth: (init.headers as any).Authorization });
    if (url.includes("/api/ia/socios")) return json({ total: 42, socios: [{ nombre: "Juana", medio_pago: "debito_automatico" }] });
    return new Response("Not found", { status: 404 });
  };
});

/** Simula a Claude: primero pide una consulta, después responde con lo que recibió. */
function fakeClaude(toolName: string, input: unknown) {
  claudeDeps.request = async (body: any) => {
    claudeCalls.push(body);
    const last = body.messages.at(-1);
    if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
      const result = last.content[0];
      return json({ stop_reason: "end_turn", content: [{ type: "text", text: result.is_error ? `Error: ${result.content}` : `Resultado: ${result.content}` }] });
    }
    return json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: toolName, input }] });
  };
}

describe("asistente", () => {
  it("solo lo usan Administración y Ventas", async () => {
    expect((await new Client().call("GET", "/api/assistant/chats")).status).toBe(401);
    const recep = await Client.login("recep", "otra-clave-123");
    expect((await recep.call("GET", "/api/assistant/chats")).status).toBe(403);
    // Recepción sigue usando el resto del CRM.
    expect((await recep.call("GET", "/api/tags")).status).toBe(200);
    const caro = await Client.login("caro", "otra-clave-123");
    expect((await caro.call("GET", "/api/assistant/status")).body).toEqual({ configured: true, mainAppConfigured: true });
  });

  it("sin clave de Claude avisa que falta configurar", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const admin = await Client.login("leandro", "clave-segura-123");
    const res = await admin.call("POST", "/api/assistant/ask", { question: "¿Cuántos socios hay?" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("consulta la app con el token, responde y guarda el chat", async () => {
    fakeClaude("buscar_socios", { medio_pago: "debito_automatico", limite: 1, inventado: "x" });
    const caro = await Client.login("caro", "otra-clave-123");
    const res = await caro.call("POST", "/api/assistant/ask", { question: "¿Cuántos pagan por débito automático?" });
    expect(res.status).toBe(200);
    expect(res.body.message.text).toContain('"total":42');
    expect(res.body.message.tools).toEqual([{ name: "buscar_socios", input: { medio_pago: "debito_automatico", limite: 1, inventado: "x" } }]);
    // Solo manda parámetros conocidos, con el token de la app.
    expect(appCalls.filter(c => !c.url.includes("diccionario"))).toEqual([{ url: "https://app.ejemplo.com/api/ia/socios?medio_pago=debito_automatico&limite=1", auth: "Bearer token-app" }]);
    // A Claude le llega la fecha de hoy y el nombre de quien pregunta.
    expect(claudeCalls[0].system[0].text).toContain("Carolina Paz");
    // Caché: instrucciones, herramientas y el último mensaje marcados.
    expect(claudeCalls[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(claudeCalls[0].tools.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(claudeCalls[1].messages.at(-1).content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    expect(claudeCalls[1].messages[0].content).toBe("¿Cuántos pagan por débito automático?"); // los anteriores sin marca
    expect(claudeCalls[0].tools.map((t: any) => t.name)).toContain("socios_sin_renovar");

    const chats = (await caro.call("GET", "/api/assistant/chats")).body;
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe("¿Cuántos pagan por débito automático?");

    // Segunda pregunta en el mismo chat: le pasa el historial.
    await caro.call("POST", "/api/assistant/ask", { chatId: res.body.chatId, question: "¿Y de esos cuántos en la sede 2?" });
    const second = claudeCalls.at(-2);
    expect(second.messages.slice(0, 2).map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect((await caro.call("GET", `/api/assistant/chats/${res.body.chatId}`)).body).toHaveLength(4);

    // Otro usuario no ve ese chat; el admin lo ve en el registro.
    const admin = await Client.login("leandro", "clave-segura-123");
    expect((await admin.call("GET", `/api/assistant/chats/${res.body.chatId}`)).status).toBe(404);
    const log = (await admin.call("GET", "/api/assistant/log")).body;
    expect(log[0]).toMatchObject({ userName: "Carolina Paz", question: "¿Y de esos cuántos en la sede 2?" });
    expect((await caro.call("GET", "/api/assistant/log")).status).toBe(403);
  });

  it("si la consulta todavía no existe en la app, se lo dice a Claude como error", async () => {
    fakeClaude("socios_sin_renovar", { mes: "2026-10" });
    const admin = await Client.login("leandro", "clave-segura-123");
    const res = await admin.call("POST", "/api/assistant/ask", { question: "¿Quiénes no renovaron el mes pasado?" });
    expect(res.body.message.text).toContain("todavía no está disponible");
    expect(res.body.message.tools[0]).toMatchObject({ name: "socios_sin_renovar", error: true });
  });

  it("borra un chat propio", async () => {
    fakeClaude("resumen_socios", {});
    const admin = await Client.login("leandro", "clave-segura-123");
    const { body } = await admin.call("POST", "/api/assistant/ask", { question: "Resumen" });
    expect((await admin.call("DELETE", `/api/assistant/chats/${body.chatId}`)).status).toBe(200);
    expect((await admin.call("GET", `/api/assistant/chats/${body.chatId}`)).status).toBe(404);
  });
});

describe("consulta libre", () => {
  it("manda la consulta SQL por POST con el token", async () => {
    let seen: any = null;
    toolDeps.mainAppRequest = async (url, init) => { seen = { url, method: init.method, body: init.body, auth: (init.headers as any).Authorization };
      return json({ columnas: ["n"], filas: [[12]], recortado: false }); };
    fakeClaude("consulta_sql", { sql: "SELECT count(*) n FROM socios WHERE edad < 8" });
    const admin = await Client.login("leandro", "clave-segura-123");
    const res = await admin.call("POST", "/api/assistant/ask", { question: "¿Cuántos socios tienen menos de 8 años?" });
    expect(res.body.message.text).toContain('"filas":[[12]]');
    expect(seen).toEqual({ url: "https://app.ejemplo.com/api/ia/consulta", method: "POST", body: JSON.stringify({ sql: "SELECT count(*) n FROM socios WHERE edad < 8", alcance: "admin" }), auth: "Bearer token-app" });
  });

  it("solo administradores y "Solo asistente" acceden a los datos del personal (Claude no lo puede forzar)", async () => {
    const bodies: any[] = [], dics: string[] = [];
    toolDeps.mainAppRequest = async (url, init) => {
      if (url.includes("diccionario")) { dics.push(url); return json({ diccionario: url.includes("alcance=admin") ? "- asistencia_personal(...)" : "- socios(...)" }); }
      bodies.push(JSON.parse(String(init.body))); return json({ columnas: ["n"], filas: [[1]], recortado: false });
    };
    const admin = await Client.login("leandro", "clave-segura-123");
    await admin.call("POST", "/api/users", { username: "coordi", name: "Coordi", role: "vendedor", password: "clave-coordi-123" });
    const seller = await Client.login("coordi", "clave-coordi-123");
    fakeClaude("consulta_sql", { sql: "SELECT count(*) n FROM asistencia_personal", alcance: "admin" });
    await seller.call("POST", "/api/assistant/ask", { question: "¿Quién llegó tarde?" });
    expect(bodies.at(-1)).toEqual({ sql: "SELECT count(*) n FROM asistencia_personal" });
    expect(claudeCalls.at(-1).system[0].text).not.toContain("asistencia_personal(");
    await admin.call("POST", "/api/assistant/ask", { question: "¿Quién llegó tarde?" });
    expect(bodies.at(-1)).toEqual({ sql: "SELECT count(*) n FROM asistencia_personal", alcance: "admin" });
    expect(claudeCalls.at(-1).system[0].text).toContain("asistencia_personal(");
    expect(dics).toHaveLength(2); // uno por alcance
    await admin.call("POST", "/api/users", { username: "hermano2", name: "Hermano", role: "asistente", password: "clave-hermano-123" });
    const bro = await Client.login("hermano2", "clave-hermano-123");
    await bro.call("POST", "/api/assistant/ask", { question: "¿Quién llegó tarde?" });
    expect(bodies.at(-1)).toEqual({ sql: "SELECT count(*) n FROM asistencia_personal", alcance: "admin" });
  });
});

describe("rol solo asistente", () => {
  it("usa el asistente pero no ve el resto del CRM", async () => {
    const admin = await Client.login("leandro", "clave-segura-123");
    const created = await admin.call("POST", "/api/users", { username: "hermano", name: "Hermano", role: "asistente", password: "clave-hermano-123" });
    expect(created.status).toBe(200);
    const bro = await Client.login("hermano", "clave-hermano-123");
    expect((await bro.call("GET", "/api/auth/me")).body.role).toBe("asistente");
    expect((await bro.call("GET", "/api/assistant/chats")).status).toBe(200);
    for (const path of ["/api/whatsapp/conversations", "/api/tags", "/api/users", "/api/whatsapp/status", "/api/assistant/log"])
      expect((await bro.call("GET", path)).status, path).toBe(403);
    fakeClaude("resumen_socios", {});
    expect((await bro.call("POST", "/api/assistant/ask", { question: "Resumen" })).status).toBe(200);
  });
});


describe("costo", () => {
  it("incluye el diccionario en las instrucciones y no ofrece diccionario_datos", async () => {
    toolDeps.mainAppRequest = async (url, init) => { appCalls.push({ url, auth: (init.headers as any).Authorization }); return url.includes("diccionario")
      ? json({ diccionario: "- socios(id_evo, edad): una fila por socio" }) : json({ columnas: ["n"], filas: [[1]], recortado: false }); };
    claudeDeps.request = async (body: any) => { claudeCalls.push(body);
      return json({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 5 } }); };
    const admin = await Client.login("leandro", "clave-segura-123");
    await admin.call("POST", "/api/assistant/ask", { question: "Hola" });
    await admin.call("POST", "/api/assistant/ask", { question: "Hola 2" });
    expect(claudeCalls[0].system[0].text).toContain("socios(id_evo, edad)");
    expect(claudeCalls[0].tools.map((t: any) => t.name)).not.toContain("diccionario_datos");
    expect(appCalls.filter(c => c.url.includes("diccionario"))).toHaveLength(1); // guardado 1 hora
    const log = (await admin.call("GET", "/api/assistant/log")).body;
    expect(log[0].usage).toEqual({ "claude-haiku-5-5": { input: 10, cacheWrite: 0, cacheRead: 900, output: 5, steps: 1 } });
  });

  it("las preguntas simples las responde Haiku; si necesita la consulta libre pasa entera a Sonnet", async () => {
    toolDeps.mainAppRequest = async url => url.includes("diccionario") ? json({ diccionario: "- socios(...)" })
      : url.includes("consulta") ? json({ columnas: ["n"], filas: [[7]], recortado: false }) : json({ total: 42 });
    const admin = await Client.login("leandro", "clave-segura-123");
    fakeClaude("resumen_socios", {});
    const simple = await admin.call("POST", "/api/assistant/ask", { question: "¿Cuántos socios activos hay?" });
    expect(claudeCalls.map(c => c.model)).toEqual(["claude-haiku-5-5", "claude-haiku-5-5"]);
    expect(simple.body.message.text).toContain('"total":42');
    claudeCalls = [];
    fakeClaude("consulta_sql", { sql: "SELECT count(*) n FROM socios" });
    const complex = await admin.call("POST", "/api/assistant/ask", { question: "¿Cuántos socios por edad y plan?" });
    expect(claudeCalls.map(c => c.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect(complex.body.message.text).toContain('"filas":[[7]]');
    expect(complex.body.message.tools).toEqual([{ name: "consulta_sql", input: { sql: "SELECT count(*) n FROM socios" } }]);
    claudeCalls = [];
    process.env.ANTHROPIC_FAST_MODEL = "off";
    try {
      fakeClaude("resumen_socios", {});
      await admin.call("POST", "/api/assistant/ask", { question: "Resumen" });
      expect(claudeCalls.map(c => c.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    } finally { delete process.env.ANTHROPIC_FAST_MODEL; }
  });
});
