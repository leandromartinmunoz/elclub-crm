/**
 * Herramientas del asistente: cada una es una consulta de SOLO LECTURA a la app de El Club.
 * La app expone GET /api/ia/... protegido con MAIN_APP_TOKEN (ver docs/asistente-api-replit.md).
 */
export const deps = {
  mainAppRequest: (url: string, init: RequestInit) => fetch(url, init),
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
export type Tool = { name: string; description: string; input_schema: Schema; path: string; method?: "GET" | "POST" };

const sede = { type: "string", description: "Nombre de la sede. Omitir para todas." };
const fecha = (d: string) => ({ type: "string", description: `${d} (AAAA-MM-DD)` });

export const TOOLS: Tool[] = [
  {
    name: "resumen_socios",
    path: "/api/ia/resumen",
    description: "Totales de socios ACTIVOS: por sede, por medio de pago de su último cobro, por plan vigente, por rango de edad (y edad promedio) y por género. Usala primero para cantidades generales y para conocer los nombres exactos de sedes, planes y medios de pago.",
    input_schema: { type: "object", properties: { sede } },
  },
  {
    name: "buscar_socios",
    path: "/api/ia/socios",
    description: "Cuenta y lista socios con filtros combinables. Devuelve { total, mostrados, socios } (total es el real aunque la lista se corte en 'limite'). Cada socio trae teléfono, edad y fecha de nacimiento, género y ciudad (si están cargados), plan vigente, vencimiento, fecha de alta, última asistencia, asistencias de los últimos 30 días, medio y fecha de su último cobro, y deuda. Sirve para: edad y cumpleaños, medio de pago, antigüedad (fecha de alta), inactivos (sin asistir X días), con deuda, por plan, sede o vencimiento.",
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
        edad_min: { type: "integer", minimum: 0, maximum: 120 },
        edad_max: { type: "integer", minimum: 0, maximum: 120 },
        cumple_desde: { type: "string", description: "Cumpleaños desde (MM-DD). Usar junto con cumple_hasta; puede cruzar fin de año." },
        cumple_hasta: { type: "string", description: "Cumpleaños hasta (MM-DD)." },
        genero: { type: "string", description: "Como lo informa EVO (ver por_genero en resumen_socios)." },
        ciudad: { type: "string", description: "Ciudad o barrio (texto contenido), si EVO lo tiene cargado." },
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
  {
    name: "diccionario_datos",
    path: "/api/ia/diccionario",
    description: "Describe las vistas de datos de la app para consulta_sql (socios, membresías con categoría y débito, cobros, ventas, prospectos, asistencias, consultores, rutinas, profesores, ingresos de recepción, incidencias) con sus columnas y reglas. Llamala antes de tu primera consulta_sql en la conversación.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "consulta_sql",
    path: "/api/ia/consulta",
    method: "POST",
    description: "Ejecuta UNA consulta SQL de solo lectura (SELECT o WITH, dialecto PostgreSQL, sin ';' ni comentarios) sobre las vistas del diccionario. Devuelve { columnas, filas, recortado } con hasta 500 filas. Si da error, leé el mensaje y corregí la consulta. Preferí agregaciones (COUNT, SUM, GROUP BY) a traer filas sueltas.",
    input_schema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] },
  },
];

/** Diccionario de vistas de la consulta libre, pedido a la app y guardado 1 hora. null = no disponible. */
let dictionaryCache: { text: string; at: number } | null = null;
export async function fetchDictionary(): Promise<string | null> {
  if (dictionaryCache && Date.now() - dictionaryCache.at < 3_600_000) return dictionaryCache.text;
  const base = process.env.MAIN_APP_URL, token = process.env.MAIN_APP_TOKEN;
  if (!base || !token) return null;
  try {
    const response = await deps.mainAppRequest(new URL("/api/ia/diccionario", base).toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const text = (await response.json() as { diccionario?: unknown }).diccionario;
    if (typeof text !== "string" || !text) return null;
    dictionaryCache = { text, at: Date.now() };
    return text;
  } catch { return null; }
}
export const clearDictionaryCache = () => { dictionaryCache = null; };

/** Lo que se le manda a Claude (sin la ruta interna). */
export const toolDefinitions = TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

const MAX_RESULT = 15_000; // caracteres por resultado: alcanza para tablas de ~150 filas y abarata cada paso

export type ToolOutcome = { content: string; isError: boolean };

export async function runTool(name: string, input: unknown): Promise<ToolOutcome> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return { content: `No existe la consulta "${name}".`, isError: true };
  const base = process.env.MAIN_APP_URL, token = process.env.MAIN_APP_TOKEN;
  if (!base || !token) return { content: "La conexión con la app de El Club no está configurada.", isError: true };

  const url = new URL(tool.path, base);
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (!(key in tool.input_schema.properties)) continue; // solo parámetros conocidos
    if (["string", "number", "boolean"].includes(typeof value)) params[key] = value;
  }
  const post = tool.method === "POST";
  if (!post) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  try {
    const response = await deps.mainAppRequest(url.toString(), {
      method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(post ? { "Content-Type": "application/json" } : {}) },
      ...(post ? { body: JSON.stringify(params) } : {}),
      signal: AbortSignal.timeout(post ? 30_000 : 15_000),
    });
    // Por contrato, las consultas responden 200 aunque no haya resultados: un 404 es que falta crearla.
    if (response.status === 404)
      return { content: "Esta consulta todavía no está disponible en la app de El Club.", isError: true };
    const text = await response.text();
    if (!response.ok) return { content: `La app de El Club respondió con error ${response.status}: ${text.slice(0, 600)}`, isError: true };
    return {
      content: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[resultado recortado: pedí menos filas (limite / LIMIT) o agrupá con COUNT/SUM]` : text,
      isError: false,
    };
  } catch {
    return { content: "No se pudo consultar la app de El Club (no respondió a tiempo).", isError: true };
  }
}
