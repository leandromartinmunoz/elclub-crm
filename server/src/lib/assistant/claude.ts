/**
 * Conversación con Claude (API de Anthropic) usando herramientas.
 * Claude decide qué consultas hacer; el CRM las ejecuta contra la app de El Club y le devuelve los datos.
 */
import { UserFacingError } from "../errors.js";
import type { SessionUser } from "../auth.js";
import { runTool, toolDefinitions } from "./tools.js";

export const claudeDeps = {
  request: async (body: unknown): Promise<Response> => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  }),
};

export const assistantConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);
const model = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_STEPS = 12;

const roleLabel: Record<SessionUser["role"], string> = { admin: "administración", vendedor: "ventas", recepcion: "recepción" };

function systemPrompt(user: SessionUser, now = new Date()) {
  const today = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Cordoba", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Cordoba" }).format(now);
  return `Sos el asistente interno de El Club, un gimnasio de Alta Gracia (Córdoba, Argentina) con dos sedes, una con pileta.
Le respondés a ${user.name} (área: ${roleLabel[user.role]}). Hoy es ${today} (${iso}).

Cómo trabajás:
- Respondé SOLO con datos que obtengas de las consultas disponibles. Nunca inventes números ni nombres. Si una consulta falla o no existe, decilo claramente.
- Los datos son copias de EVO que se actualizan de noche, no en vivo. Cada resultado trae 'actualizado' y 'notas': respetá esas notas (ej. medio de pago = el del último cobro; no figurar en deudores no es deuda cero; 'pendiente' no es baja).
- Para bajas, renovaciones y vencimientos usá las consultas fijas (coinciden con los reportes). Para todo lo demás (edades, categorías como Débitos, cobros y facturación, ventas por vendedora, prospectos y conversión, rutinas, profesores, incidencias, cruces entre datos) usá diccionario_datos y consulta_sql.
- Con consulta_sql: contá personas únicas con COUNT(DISTINCT id_evo) cuando corresponda (un socio puede estar en las dos sedes); en una línea al final contá cómo lo calculaste (qué datos y qué filtro), sin mostrar el SQL salvo que te lo pidan.
- Primero el dato pedido (el total), después el detalle. Si la lista es larga, mostrá una tabla con lo esencial y aclarás cuántos hay en total.
- Antigüedad: se calcula desde la fecha de alta. "Cumplen 3 meses en diciembre" = fecha de alta en septiembre.
- DEUDA: hoy la copia del padrón de deudores de EVO llega sin socios identificados ni importes, así que no hay datos de deuda. Si preguntan por deuda, decí que ese dato todavía no está disponible (no digas que nadie debe).
- Si no sabés el nombre exacto de una sede, plan o medio de pago, consultá primero resumen_socios.
- Si la pregunta es ambigua (ej. qué período), elegí la lectura más razonable y aclarala en una línea.
- Mostrá solo los datos personales necesarios para la tarea (nombre, teléfono, plan, fechas). Nunca DNI ni datos bancarios salvo que te los pidan explícitamente para un socio puntual.
- Español rioplatense, breve y directo. Formato: markdown simple (negritas, listas y tablas).`;
}

export type HistoryItem = { role: "user" | "assistant"; text: string };
export type ToolCall = { name: string; input: unknown; error?: boolean };

async function callClaude(body: unknown) {
  let response: Response;
  try {
    response = await claudeDeps.request(body);
  } catch {
    throw new UserFacingError("Claude no respondió a tiempo. Probá de nuevo.", 504);
  }
  if (response.status === 401) throw new UserFacingError("La clave de Claude (ANTHROPIC_API_KEY) no es válida.", 502);
  if (response.status === 429 || response.status === 529) throw new UserFacingError("Claude está con mucha demanda. Probá en un minuto.", 503);
  if (!response.ok) {
    console.error("Error de Claude", response.status, await response.text().catch(() => ""));
    throw new UserFacingError("Claude devolvió un error. Probá de nuevo.", 502);
  }
  return await response.json() as { content: any[]; stop_reason: string };
}

/** Responde una pregunta usando el historial del chat. Devuelve el texto y las consultas hechas. */
export async function answer(user: SessionUser, history: HistoryItem[], question: string) {
  if (!assistantConfigured()) throw new UserFacingError("Falta configurar ANTHROPIC_API_KEY en el servidor.", 503);
  const messages: any[] = [
    ...history.map(h => ({ role: h.role, content: h.text })),
    { role: "user", content: question },
  ];
  const tools: ToolCall[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await callClaude({
      model: model(), max_tokens: 4096, system: systemPrompt(user), tools: toolDefinitions, messages,
    });
    messages.push({ role: "assistant", content: result.content });
    const uses = result.content.filter(block => block.type === "tool_use");
    if (result.stop_reason !== "tool_use" || !uses.length) {
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
      return { text: text || "No tengo una respuesta para eso.", tools };
    }
    const results = [];
    for (const use of uses) {
      const outcome = await runTool(use.name, use.input);
      tools.push({ name: use.name, input: use.input, ...(outcome.isError ? { error: true } : {}) });
      results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.content, is_error: outcome.isError });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "La consulta necesitó demasiados pasos. Probá dividirla en preguntas más simples.", tools };
}
