// Lectura de los webhooks de Instagram (mensajes directos) que manda Meta.
export type IgMessage = {
  accountId: string;   // cuenta profesional de Instagram de El Club
  contactId: string;   // IGSID del cliente
  providerId: string;  // mid del mensaje
  direction: "inbound" | "outbound"; // outbound = eco de un mensaje enviado (desde el CRM o desde la app de Instagram)
  type: string;
  text: string;
  occurredAt: Date;
};

const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const igId = (v: unknown) => /^\d{5,40}$/.test(String(v ?? "")) ? String(v) : null;

const attachmentName: Record<string, string> = {
  image: "Imagen", video: "Video", audio: "Audio", file: "Archivo", share: "Publicación compartida",
  story_mention: "Te mencionó en una historia", ig_reel: "Reel", reel: "Reel", animated_image: "GIF", sticker: "Sticker",
};

export function parseInstagramEvents(payload: unknown): IgMessage[] {
  const out: IgMessage[] = [];
  if (obj(payload).object !== "instagram") return out;
  for (const entry of array(obj(payload).entry)) {
    const accountId = igId(obj(entry).id);
    if (!accountId) continue;
    for (const raw of array(obj(entry).messaging)) {
      const event = obj(raw), message = obj(event.message);
      const providerId = String(message.mid ?? "");
      if (!providerId || providerId.length > 500 || message.is_deleted || message.is_unsupported) continue;
      const echo = message.is_echo === true;
      const contactId = igId(echo ? obj(event.recipient).id : obj(event.sender).id);
      const occurredAt = new Date(Number(event.timestamp));
      if (!contactId || contactId === accountId || !Number.isFinite(occurredAt.getTime())) continue;
      const attachments = array(message.attachments).map(a => String(obj(a).type ?? ""));
      let type = "text", text = typeof message.text === "string" ? message.text : "";
      if (attachments.length) {
        type = attachments[0].slice(0, 40) || "attachment";
        const label = `[${attachmentName[type] ?? "Adjunto"}]`;
        text = text ? `${label} ${text}` : label;
      }
      if (obj(message.reply_to).story) text = `[Respuesta a una historia] ${text}`.trim();
      if (!text) continue;
      out.push({ accountId, contactId, providerId, direction: echo ? "outbound" : "inbound", type, text: text.slice(0, 8192), occurredAt });
    }
  }
  if (out.length > 2000) throw new Error("Too many Instagram events");
  return out;
}

export function instagramError(code?: number, subcode?: number) {
  if (code === 10 && subcode === 2534022) return "Pasaron 24 horas desde el último mensaje del contacto. Esperá un nuevo mensaje para responder desde esta bandeja.";
  if (code === 190 || code === 10 || code === 200) return "Revisá el token de Instagram (INSTAGRAM_ACCESS_TOKEN) en el servidor.";
  if (code === 4 || code === 613 || code === 32) return "Meta limitó temporalmente los envíos. No se volverá a enviar automáticamente.";
  if (code === 551 || code === 100) return "Instagram no permite enviarle mensajes a este contacto.";
  return "Meta rechazó el envío. Revisá la conexión antes de volver a intentarlo.";
}
