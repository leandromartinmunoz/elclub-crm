/**
 * Levanta el CRM con una base en memoria y datos de ejemplo, para ver la pantalla sin Postgres.
 *   npx tsx scripts/demo.ts   →  http://localhost:3000  (usuario: demo / clave: demo-demo-123)
 */
import { PGlite } from "@electric-sql/pglite";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, setDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/lib/auth.js";
import { claudeDeps } from "../src/lib/assistant/claude.js";
import { deps as toolDeps } from "../src/lib/assistant/tools.js";

const pg = new PGlite();
const run = (q: any) => async (sql: string, params?: unknown[]) =>
  !params?.length && sql.includes(";") ? { rows: ((await q.exec(sql)).at(-1)?.rows ?? []) as any[] }
    : { rows: (await q.query(sql, params)).rows as any[] };
const db: Db = { query: run(pg), transaction: work => pg.transaction(tx => work({ query: run(tx) })) };
setDb(db);
await migrate(db);

const pw = await hashPassword("demo-demo-123");
await db.query(`INSERT INTO users(username,name,role,password_hash) VALUES
  ('demo','Leandro Muñoz','admin',$1),('caro','Carolina Paz','vendedor',$1),('recep','Recepción Sarmiento','recepcion',$1)`, [pw]);
await db.query(`INSERT INTO whatsapp_accounts(id,label,display_phone,verified_name,created_by,last_event_at)
  VALUES('1072906325127271','El Club','+54 9 3547 32-5050','El Club','demo',now())`);

await db.query(`INSERT INTO whatsapp_accounts(id,channel,page_id,label,display_phone,verified_name,created_by,last_event_at)
  VALUES('17841400000000001','instagram','100000000000001','Instagram @gimnasioelclub','@gimnasioelclub','El Club','demo',now())`);

const chats: [string, string, string[][], number | null, string[], string?][] = [
  ["6100000000000001", "Valentina Ríos (@valen.rios)", [["in", "Hola! Vi el reel de la pileta, ¿tienen clases para chicos?", "8"]], null, ["Prospecto"], "17841400000000001"],
  ["6100000000000002", "@nico.entrena", [["in", "Precio del pase libre?", "95"], ["out", "Hola Nico! Te paso todo por acá 💪", "90"]], 2, ["Consulta"], "17841400000000001"],
  ["5493547401122", "Martina Gómez", [["in", "Hola! Quería saber horarios de pileta libre para adultos", "190"], ["out", "Hola Martina! En Ecuador la pileta libre es de 7 a 9 y de 19 a 22 h.", "185"], ["in", "Y el valor mensual?", "12"]], 2, ["Prospecto"]],
  ["5493547559900", "Diego Ferreyra", [["in", "Buenas, se me venció la cuota y no puedo pasar el molinete", "45"]], null, ["No renovó"]],
  ["5493516223344", "Lucía Bustos", [["in", "Me pasan el cbu para transferir?", "300"], ["out", "Sí Lucía, te lo paso por acá. ¿Abonás el plan musculación 3 veces?", "290"], ["in", "Sí, ese", "280"]], 1, ["Socio", "Deudor"]],
  ["5493547112233", "Ramiro", [["in", "Tienen clases de funcional los sábados?", "1500"]], null, ["Consulta"]],
  ["5493547998877", "Sofía Herrera", [["in", "Gracias por todo!! nos vemos mañana", "2000"]], 1, ["Socio"]],
];
let n = 0;
for (const [phone, name, msgs, assigned, tagNames, account = "1072906325127271"] of chats) {
  const last = msgs.at(-1)!;
  const lastIn = [...msgs].reverse().find(m => m[0] === "in")!;
  const { rows: [c] } = await db.query(`INSERT INTO whatsapp_conversations(account_id,contact_phone,contact_name,preview,last_message_at,last_inbound_at,assigned_to)
    VALUES($7,$1,$2,$3,now()-($4||' minutes')::interval,now()-($5||' minutes')::interval,$6) RETURNING id`,
    [phone, name, last[1], last[2], lastIn[2], assigned, account]);
  for (const [dir, text, ago] of msgs)
    await db.query(`INSERT INTO whatsapp_messages(conversation_id,direction,text,status,provider_id,occurred_at,sender_name)
      VALUES($1,$2,$3,$4,$5,now()-($6||' minutes')::interval,$7)`,
      [c.id, dir === "in" ? "inbound" : "outbound", text, dir === "in" ? "received" : "read", `demo.${n++}`, ago, dir === "in" ? null : "Carolina Paz"]);
  for (const t of tagNames) await db.query("INSERT INTO conversation_tags SELECT $1,id FROM tags WHERE name=$2", [c.id, t]);
}
await db.query(`INSERT INTO whatsapp_reads SELECT id,'demo',(SELECT max(id) FROM whatsapp_messages m WHERE m.conversation_id=c.id)
  FROM whatsapp_conversations c WHERE contact_name='Sofía Herrera'`);
await db.query(`INSERT INTO conversation_notes(conversation_id,user_id,author_name,text)
  SELECT id,2,'Carolina Paz','Interesada en plan pileta + musculación. Viene el jueves a conocer.' FROM whatsapp_conversations WHERE contact_name='Martina Gómez'`);

// Asistente de prueba: sin clave real, simula a Claude y a la app de El Club con datos inventados.
if (!process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = "demo";
  process.env.MAIN_APP_URL = "https://app.demo";
  process.env.MAIN_APP_TOKEN = "demo";
  const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  toolDeps.mainAppRequest = async () => reply({ total: 3, socios: [] });
  claudeDeps.request = async (body: any) => {
    const last = body.messages.at(-1);
    if (typeof last.content === "string")
      return reply({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buscar_socios", input: { medio_pago: "debito_automatico" } }] });
    return reply({ stop_reason: "end_turn", content: [{ type: "text", text:
      "Hay **128 socios activos** pagando por débito automático (datos de prueba).\n\n| Sede | Socios | % del total |\n|---|---|---|\n| Sarmiento | 81 | 38% |\n| Ecuador (pileta) | 47 | 29% |\n\nLa mayoría está en **Musculación libre** y **Pileta 2x semana**." }] });
  };
}

const here = dirname(fileURLToPath(import.meta.url));
createApp({ webDist: join(here, "..", "..", "web", "dist") }).listen(3000, () => console.log("Demo en http://localhost:3000"));
