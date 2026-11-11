import { PGlite } from "@electric-sql/pglite";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { ensureFirstAdmin } from "../src/lib/auth.js";
import { deps } from "../src/lib/whatsapp-store.js";

const SECRET = "app-secret-de-prueba";
const ACCOUNT = "123456789012345";
let server: Server, base: string, pg: PGlite;

function pgliteDb(pg: PGlite): Db {
  const run = (q: { query: PGlite["query"]; exec: PGlite["exec"] }) =>
    async (sql: string, params?: unknown[]) => {
      if (!params?.length && sql.includes(";")) { // archivos de migración con varias sentencias
        const results = await q.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as any[] };
      }
      return { rows: (await q.query(sql, params as any[])).rows as any[] };
    };
  return {
    query: run(pg),
    transaction: work => pg.transaction(tx => work({ query: run(tx as any) })),
  };
}

class Client {
  cookie = "";
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method, headers: { "content-type": "application/json", cookie: this.cookie, ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* texto plano */ }
    return { status: res.status, body: parsed };
  }
}

function webhookPayload(messages: unknown[] = [], statuses: unknown[] = []) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: ACCOUNT },
      contacts: [{ wa_id: "5493547000001", profile: { name: "Juana Socia" } }],
      messages, statuses,
    } }] }],
  };
}
async function postWebhook(payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Client().call("POST", "/api/whatsapp/webhook", raw, { "x-hub-signature-256": signature });
}

beforeAll(async () => {
  process.env.ADMIN_USERNAME = "leandro";
  process.env.ADMIN_PASSWORD = "clave-segura-123";
  process.env.WHATSAPP_APP_SECRET = SECRET;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "verificar";
  process.env.WHATSAPP_ACCESS_TOKEN = "token-falso";
  pg = new PGlite();
  const db = pgliteDb(pg);
  setDb(db);
  await migrate(db);
  await ensureFirstAdmin();
  await db.query(`INSERT INTO whatsapp_accounts(id,label,display_phone,verified_name,created_by)
    VALUES($1,'El Club','+54 9 3547 32-5050','El Club','test')`, [ACCOUNT]);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await pg.close(); });

let admin: Client;
beforeEach(async () => {
  admin = new Client();
  await admin.call("POST", "/api/auth/login", { username: "leandro", password: "clave-segura-123" });
});

describe("login", () => {
  it("rechaza sin sesión y con clave incorrecta", async () => {
    const anon = new Client();
    expect((await anon.call("GET", "/api/whatsapp/conversations")).status).toBe(401);
    expect((await anon.call("POST", "/api/auth/login", { username: "leandro", password: "mal" })).status).toBe(401);
  });
  it("crea el admin inicial y permite entrar", async () => {
    const me = await admin.call("GET", "/api/auth/me");
    expect(me.body).toMatchObject({ username: "leandro", role: "admin" });
  });
  it("un vendedor no puede crear usuarios y no ve usuarios inactivos", async () => {
    const created = await admin.call("POST", "/api/users", { username: "vende1", name: "Vende Uno", role: "vendedor", password: "otra-clave-123" });
    expect(created.status).toBe(200);
    const seller = new Client();
    expect((await seller.call("POST", "/api/auth/login", { username: "vende1", password: "otra-clave-123" })).status).toBe(200);
    expect((await seller.call("POST", "/api/users", { username: "x123", name: "X", role: "admin", password: "otra-clave-123" })).status).toBe(403);
    // Al desactivarlo se cierra su sesión.
    await admin.call("PATCH", `/api/users/${created.body.id}`, { active: false });
    expect((await seller.call("GET", "/api/auth/me")).status).toBe(401);
  });
  it("rechaza pedidos desde otro origen", async () => {
    const res = await admin.call("POST", "/api/auth/logout", {}, { origin: "https://malicioso.com" });
    expect(res.status).toBe(403);
  });
});

describe("webhook de WhatsApp", () => {
  it("rechaza firmas inválidas", async () => {
    expect((await postWebhook(webhookPayload(), "otro-secreto")).status).toBe(401);
  });
  it("verifica el webhook con el token", async () => {
    const ok = await new Client().call("GET", "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verificar&hub.challenge=42");
    expect(ok.body).toBe(42);
    const bad = await new Client().call("GET", "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42");
    expect(bad.status).toBe(403);
  });
  it("guarda mensajes entrantes una sola vez y los muestra en la bandeja", async () => {
    const msg = { from: "5493547000001", id: "wamid.1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hola, ¿precio de pileta?" } };
    expect((await postWebhook(webhookPayload([msg]))).status).toBe(200);
    await postWebhook(webhookPayload([msg])); // duplicado
    const list = await admin.call("GET", "/api/whatsapp/conversations");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ contactName: "Juana Socia", unreadCount: 1, status: "abierto", tags: [] });
    const messages = await admin.call("GET", `/api/whatsapp/conversations/${list.body.items[0].id}/messages`);
    expect(messages.body.items.map((m: any) => m.text)).toEqual(["Hola, ¿precio de pileta?"]);
    await admin.call("POST", `/api/whatsapp/conversations/${list.body.items[0].id}/read`, { throughMessageId: messages.body.items[0].id });
    expect((await admin.call("GET", "/api/whatsapp/conversations")).body.unreadTotal).toBe(0);
  });
});

describe("responder y funciones de CRM", () => {
  it("envía con el token propio, es idempotente y aplica recibos", async () => {
    const calls: any[] = [];
    deps.whatsappRequest = async (path, init) => {
      calls.push({ path, body: JSON.parse(init!.body!) });
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out1" }] }), { status: 200 });
    };
    const id = (await admin.call("GET", "/api/whatsapp/conversations")).body.items[0].id;
    const reply = { text: "Hola Juana, te paso info", clientRequestId: "8f14e45f-ceea-4e7a-9b6c-1a2b3c4d5e6f" };
    const sent = await admin.call("POST", `/api/whatsapp/conversations/${id}/messages`, reply);
    expect(sent.body).toMatchObject({ status: "accepted", senderName: "Administrador" });
    await admin.call("POST", `/api/whatsapp/conversations/${id}/messages`, reply); // reintento del navegador
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: `/${ACCOUNT}/messages`, body: { to: "5493547000001" } });
    await postWebhook(webhookPayload([], [{ id: "wamid.out1", status: "read", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "5493547000001" }]));
    const messages = await admin.call("GET", `/api/whatsapp/conversations/${id}/messages`);
    expect(messages.body.items.at(-1)).toMatchObject({ direction: "outbound", status: "read" });
  });
  it("asigna, etiqueta, cierra y agrega notas", async () => {
    const me = (await admin.call("GET", "/api/auth/me")).body;
    const id = (await admin.call("GET", "/api/whatsapp/conversations")).body.items[0].id;
    const tags = (await admin.call("GET", "/api/tags")).body;
    const prospecto = tags.find((t: any) => t.name === "Prospecto");
    await admin.call("POST", `/api/conversations/${id}/assign`, { userId: me.id });
    await admin.call("PUT", `/api/conversations/${id}/tags`, { tagIds: [prospecto.id] });
    await admin.call("POST", `/api/conversations/${id}/status`, { status: "cerrado" });
    const note = await admin.call("POST", `/api/conversations/${id}/notes`, { text: "Llamar el lunes" });
    expect(note.body).toMatchObject({ text: "Llamar el lunes", authorName: "Administrador" });
    const mine = await admin.call("GET", `/api/whatsapp/conversations?assigned=me&tag=${prospecto.id}&status=cerrado`);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ assignedName: "Administrador", status: "cerrado", tags: [{ name: "Prospecto" }] });
    expect((await admin.call("GET", "/api/whatsapp/conversations?assigned=none")).body.items).toHaveLength(0);
    // Un mensaje nuevo reabre la conversación.
    await postWebhook(webhookPayload([{ from: "5493547000001", id: "wamid.2", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Gracias" } }]));
    expect((await admin.call("GET", "/api/whatsapp/conversations")).body.items[0].status).toBe("abierto");
  });
  it("sin la app conectada, la ficha de socio informa que no está configurada", async () => {
    const id = (await admin.call("GET", "/api/whatsapp/conversations")).body.items[0].id;
    expect((await admin.call("GET", `/api/conversations/${id}/member`)).body).toEqual({ configured: false });
  });
});
