/**
 * Herramientas del asistente: cada una es una consulta de SOLO LECTURA a la app de El Club.
 * La app expone GET /api/ia/... protegido con MAIN_APP_TOKEN (ver docs/asistente-api-replit.md).
 */
export const deps = {
  mainAppRequest: (url: string, init: RequestInit) => fetch(url, init),
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
export type Tool = { name: string; description: string; input_schema: Schema; path: string };

const sede = { type: "string", description: "Nombre de la sede. Omitir para todas." };
const fecha = (d: string) => ({ type: "string", description: `${d} (AAAA-MM-DD)` });

export const TOOLS: Tool[] = [
  {
    name: "resumen_socios",
    path: "/api/ia/resumen",
    description: "Totales de socios ACTIVOS: por sede, por medio de pago de su último cobro, por plan vigente y cuántos tienen deuda. Usala primero para cantidades generales y para conocer los nombres exactos de sedes, planes y medios de pago.",
    input_schema: { type: "object", properties: { sede } },
  },
  {
    name: "buscar_socios",
    path: "/api/ia/socios",
    description: "Cuenta y lista socios con filtros combinables. Devuelve { total, mostrados, socios } (total es el real aunque la lista se corte en 'limite'). Cada socio trae teléfono, plan vigente, vencimiento, fecha de alta, última asistencia, asistencias de los últimos 30 días, medio y fecha de su último cobro, y deuda. Sirve para: medio de pago (ej. 'débito'), antigüedad (fecha de alta), inactivos (sin asistir X días), con deuda, por plan, sede o vencimiento.",
    input_schema: {
      type: "object",
      properties: {
        sede,
        estado: { type: "string", enum: ["activo", "inactivo", "todos"], description: "Por defecto: activo (marca de EVO)." },
        medio_pago: { type: "string", description: "Texto contenido en el medio de pago del ÚLTIMO cobro, con el nombre de EVO en inglés: 'Cash' (efectivo), 'Deposit' (depósito/transferencia), 'Debit card' (tarjeta de débito), 'Credit card' (tarjeta de crédito). Ver nombres exactos en resumen_socios." },
        plan: { type: "string", description: "Texto contenido en el plan vigente." },
        alta_desde: fecha("Fecha de alta desde"),
        alta_hasta: fecha("Fecha de alta hasta"),
        vence_desde: fecha("Vencimiento de la membresía desde"),
        vence_hasta: fecha("Vencimiento de la membresía hasta"),
        sin_asistir_dias: { type: "integer", minimum: 1, description: "Solo los que no vienen hace al menos estos días (o nunca registraron asistencia)." },
        con_deuda: { type: "boolean" },
        limite: { type: "integer", minimum: 1, maximum: 500, description: "Cuántos listar (por defecto 50). Para solo contar, usar 1." },
      },
    },
  },
  {
    name: "socios_sin_renovar",
    path: "/api/ia/sin-renovar",
    description: "Socios cuya membresía venció en el mes indicado y no empezaron otra en la misma sede dentro del plazo de renovación (45 días). Separa 'baja' (ya pasó el plazo) de 'pendiente' (todavía puede renovar). Devuelve { total, bajas, pendientes, socios }.",
    input_schema: {
      type: "object",
      properties: {
        mes: { type: "string", description: "Mes (AAAA-MM)." }, sede,
        plazo_dias: { type: "integer", minimum: 1, maximum: 365, description: "Plazo de renovación. Por defecto 45, como los reportes." },
      },
      required: ["mes"],
    },
  },
  {
    name: "vencimientos",
    path: "/api/ia/vencimientos",
    description: "Membresías que vencen entre dos fechas, con teléfono y si el socio ya renovó (ya_renovo). Devuelve { total, socios }.",
    input_schema: {
      type: "object",
      properties: { desde: fecha("Desde"), hasta: fecha("Hasta"), sede },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "altas_bajas",
    path: "/api/ia/altas-bajas",
    description: "Altas (inscripciones, con consultor), bajas (no renovaron, con la regla de 45 días) y cancelaciones (con motivo) entre dos fechas.",
    input_schema: {
      type: "object",
      properties: { desde: fecha("Desde"), hasta: fecha("Hasta"), sede, plazo_dias: { type: "integer", minimum: 1, maximum: 365 } },
      required: ["desde", "hasta"],
    },
  },
  {
    name: "ficha_socio",
    path: "/api/ia/socio",
    description: "Ficha de hasta 5 socios que coinciden: datos, plan, vencimiento, asistencia, deuda, últimas 6 membresías y últimos 6 cobros. Busca por nombre, DNI o teléfono.",
    input_schema: {
      type: "object",
      properties: { q: { type: "string", description: "Nombre, DNI o teléfono (mínimo 3 caracteres)." } },
      required: ["q"],
    },
  },
];

/** Lo que se le manda a Claude (sin la ruta interna). */
export const toolDefinitions = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

const MAX_RESULT = 60_000; // caracteres por resultado, para no llenar el contexto

export type ToolOutcome = { content: string; isError: boolean };

export async function runTool(name: string, input: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { content: `No existe la consulta "${name}".`, isError: true };
  const base = process.env.MAIN_APP_URL, token = process.env.MAIN_APP_TOKEN;
  if (!base || !token) return { content: "La conexión con la app de El Club no está configurada.", isError: true };

  const url = new URL(tool.path, base);
  for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (!(key in tool.input_schema.properties)) continue; // solo parámetros conocidos
    if (["string", "number", "boolean"].includes(typeof value)) url.searchParams.set(key, String(value));
  }
  try {
    const response = await deps.mainAppRequest(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    // Por contrato, las consultas responden 200 aunque no haya resultados: un 404 es que falta crearla.
    if (response.status === 404)
      return { content: "Esta consulta todavía no está disponible en la app de El Club.", isError: true };
    const text = await response.text();
    if (!response.ok) return { content: `La app de El Club respondió con error ${response.status}: ${text.slice(0, 300)}`, isError: true };
    return {
      content: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[resultado recortado: pedí menos filas con "limite"]` : text,
      isError: false,
    };
  } catch {
    return { content: "No se pudo consultar la app de El Club (no respondió a tiempo).", isError: true };
  }
}
