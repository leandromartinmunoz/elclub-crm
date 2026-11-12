-- Canal Instagram (mensajes directos) en la misma bandeja.
-- Se reutilizan las tablas whatsapp_*: una "cuenta" puede ser un número de WhatsApp
-- o una cuenta profesional de Instagram. En Instagram, contact_phone guarda el
-- identificador del contacto que da Meta (IGSID), no un teléfono.
ALTER TABLE whatsapp_accounts
  ADD COLUMN channel text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'instagram')),
  ADD COLUMN page_id text; -- solo Instagram: página de Facebook vinculada (se usa para enviar)
