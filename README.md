# CRM El Club

Bandeja de WhatsApp e Instagram y seguimiento comercial de El Club. Es una app propia, independiente de Replit, que corre en el VPS de Hostinger.

## Qué hace (v1)

- **Login del equipo** con roles: Administración, Ventas y Recepción. Cada respuesta queda firmada con el nombre de quien la envió.
- **Bandeja de WhatsApp**: recibe los mensajes del número de El Club y permite responder desde la computadora o el celular.
  - Meta solo deja responder durante las 24 h siguientes al último mensaje del cliente. La barra de arriba del chat muestra cuánto tiempo queda.
  - Nunca envía duplicados: si un envío queda en duda, se marca "Sin confirmar" y no se reintenta solo.
- **Instagram (mensajes directos)** en la misma bandeja, marcado con **IG** (WhatsApp con **WA**) y con filtro por canal.
  - Muestra los mensajes nuevos desde que se vincula la cuenta, también los que se respondan desde la app de Instagram ("Desde Instagram").
  - Misma regla de 24 h. Mensajes de hasta 1000 caracteres. La ficha de socio no aplica (Instagram no da teléfono).
- **Seguimiento**: asignar cada chat a un responsable, etiquetas (Prospecto, Socio, Deudor, No renovó, Consulta), cerrar o reabrir chats y notas internas que solo ve el equipo.
- **Ficha del socio**: si se conecta con la app de El Club, muestra plan, sede, vencimiento y deuda del número que escribe.

## Estructura

```
server/   API (Node + Express + Postgres)
  migrations/   cambios de la base, se aplican solos al arrancar
  tests/        pruebas automáticas (npm test)
  scripts/demo.ts   versión de prueba con datos inventados
web/      pantalla (React)
compose.yml   app + base de datos para el VPS
```

## Probar en la compu

```bash
cd web && npm install && npm run build
cd ../server && npm install && npx tsx scripts/demo.ts
# abrir http://localhost:3000  — usuario: demo / clave: demo-demo-123
```

Pruebas: `cd server && npm test`.

## Instalar en el VPS

El servidor ya tiene Docker y Caddy (`/opt/apps/caddy`), que reparte los subdominios con HTTPS.

1. DNS: registro **A** `crm` → IP del VPS.
2. En el VPS:
   ```bash
   git clone https://github.com/leandromartinmunoz/elclub-crm /opt/apps/crm
   cd /opt/apps/crm && cp .env.example .env && nano .env   # completar
   docker compose up -d --build
   ```
3. En `/opt/apps/caddy/Caddyfile` agregar:
   ```
   crm.gimnasioelclub.com.ar {
     reverse_proxy crm:3000
   }
   ```
   y `docker compose -f /opt/apps/caddy/compose.yml restart caddy`.
4. Entrar con el usuario admin del `.env`, ir a **Conexiones** y vincular el número con su ID de Meta (Phone number ID).

### Pasar WhatsApp de Replit al CRM (una sola vez)

Meta manda los mensajes entrantes a **una sola dirección**. Cuando el CRM esté probado:

1. Meta for Developers → app "EL Club - Comunicacion" → WhatsApp → Configuración → Webhook.
2. URL: `https://crm.gimnasioelclub.com.ar/api/whatsapp/webhook`, token de verificación: el `WHATSAPP_WEBHOOK_VERIFY_TOKEN` del `.env`.
3. Suscribir el campo `messages`.

Para volver atrás, se pone de nuevo la dirección anterior.

### Conectar Instagram

No necesita la revisión de Meta: la app solo maneja la cuenta propia de El Club (acceso estándar).

1. La cuenta de Instagram tiene que ser **profesional** y estar vinculada a la **página de Facebook** de El Club.
2. Meta Business → Configuración del negocio → Usuarios del sistema → **ElClub API**: asignarle la página de Facebook (control total) y generar un token con los permisos `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `instagram_basic`, `instagram_manage_messages`, `business_management`. Con ese token, `GET /me/accounts` devuelve el **token de la página**: va en `INSTAGRAM_ACCESS_TOKEN` del `.env` (no vence).
3. Meta for Developers → app "EL Club - Comunicacion" → agregar el producto **Instagram** (si no está) → Webhooks → objeto **Instagram**: URL `https://crm.gimnasioelclub.com.ar/api/instagram/webhook`, mismo token de verificación, suscribir `messages`. Esto **no** toca el webhook de WhatsApp.
4. En la app de Instagram: Configuración → Mensajes → **Permitir acceso a los mensajes** (herramientas conectadas).
5. En el CRM → **Conexiones** → Instagram: pegar el ID de la página de Facebook y tocar "Vincular Instagram".

## Actualizar

```bash
cd /opt/apps/crm && git pull && docker compose up -d --build
```
