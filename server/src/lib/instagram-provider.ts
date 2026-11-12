import { UserFacingError } from "./errors.js";
import { instagramError } from "./instagram-protocol.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string };

/**
 * Llama a la API de Meta para Instagram con el token de la página de Facebook de El Club
 * (token de página obtenido con el usuario del sistema: no vence). Nunca expone ni guarda el token.
 */
export async function instagramRequest(path: string, init: RequestOptions = {}): Promise<Response> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) throw new UserFacingError("Falta configurar INSTAGRAM_ACCESS_TOKEN en el servidor.", 503);
  return fetch(`https://graph.facebook.com/${GRAPH_VERSION}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
}

async function readJson(response: Response) {
  try { return await response.json() as any; }
  catch { throw new UserFacingError("Meta no devolvió una respuesta válida. No se guardó ningún cambio.", 502); }
}

/** Verifica la página de Facebook, obtiene su cuenta de Instagram y suscribe la página a los mensajes. */
export async function verifyInstagramPage(pageId: string) {
  let response: Response;
  try { response = await instagramRequest(`/${pageId}?fields=id,name,instagram_business_account{id,username,name}`); }
  catch (error) {
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError("No se pudo consultar Meta. No se guardó ningún cambio.", 503);
  }
  const data = await readJson(response);
  if (!response.ok) throw new UserFacingError(instagramError(data.error?.code, data.error?.error_subcode), 400);
  const ig = data.instagram_business_account;
  if (data.id !== pageId || !ig?.id)
    throw new UserFacingError("Esa página no tiene una cuenta profesional de Instagram vinculada, o el token no tiene acceso.", 400);
  const subscribe = await instagramRequest(`/${pageId}/subscribed_apps?subscribed_fields=messages`, { method: "POST" });
  if (!subscribe.ok) {
    const error = await readJson(subscribe);
    throw new UserFacingError(`La página no se pudo suscribir a los mensajes. ${instagramError(error.error?.code, error.error?.error_subcode)}`, 400);
  }
  return { pageId, igId: String(ig.id), username: String(ig.username ?? ""), name: String(ig.name ?? data.name ?? "Instagram") };
}

/** Nombre del contacto de Instagram ("Nombre (@usuario)"). Si falla, devuelve null. */
export async function instagramProfile(contactId: string): Promise<string | null> {
  try {
    const response = await instagramRequest(`/${contactId}?fields=name,username`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    const username = typeof data.username === "string" ? data.username.slice(0, 100) : "";
    const name = typeof data.name === "string" ? data.name.slice(0, 150) : "";
    if (name && username) return `${name} (@${username})`;
    return name || (username ? `@${username}` : null);
  } catch { return null; }
}
