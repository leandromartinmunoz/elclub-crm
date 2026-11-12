import { PGlite } from "@electric-sql/pglite";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { ensureFirstAdmin, hashPassword } from "../src/lib/auth.js";
import { claudeDeps } from "../src/lib/assistant/claude.js";
import { deps as toolDeps } from "../src/lib/assistant/tools.js";

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
  claudeCalls = []; appCalls = [];
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
    expect(appCalls).toEqual([{ url: "https://app.ejemplo.com/api/ia/socios?medio_pago=debito_automatico&limite=1", auth: "Bearer token-app" }]);
    // A Claude le llega la fecha de hoy y el nombre de quien pregunta.
    expect(claudeCalls[0].system).toContain("Carolina Paz");
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
