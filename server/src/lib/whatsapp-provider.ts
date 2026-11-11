import { UserFacingError } from "./errors.js";
import { whatsappError } from "./whatsapp-protocol.js";

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v23.0";
type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string };

/** Llama a la API de WhatsApp de Meta con el token propio. Nunca expone ni guarda el token. */
export async function whatsappRequest(path: string, init: RequestOptions = {}): Promise<Response> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new UserFacingError("Falta configurar WHATSAPP_ACCESS_TOKEN en el servidor.", 503);
  return fetch(`https://graph.facebook.com/${GRAPH_VERSION}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
}

export async function verifyWhatsappPhone(id: string) {
  let response: Response;
  try { response = await whatsappRequest(`/${id}?fields=id,display_phone_number,verified_name`); }
  catch (error) {
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError("No se pudo consultar Meta. No se guardó ningún cambio.", 503);
  }
  let data: any;
  try { data = await response.json(); }
  catch { throw new UserFacingError("Meta no devolvió una respuesta válida. No se guardó ningún cambio.", 502); }
  if (!response.ok) throw new UserFacingError(whatsappError(data.error?.code), response.status === 401 || response.status === 403 ? 502 : 400);
  if (data.id !== id || !data.display_phone_number)
    throw new UserFacingError("Ese ID no corresponde a un número de WhatsApp Business accesible con este token.", 400);
  return { id, displayPhone: String(data.display_phone_number), verifiedName: String(data.verified_name ?? data.display_phone_number) };
}
