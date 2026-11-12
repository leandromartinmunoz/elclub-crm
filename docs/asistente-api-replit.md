# Asistente — API de solo lectura de la app de El Club

El asistente del CRM le hace preguntas a Claude, y Claude pide datos a la app de El Club (Replit) por estas consultas.
Están implementadas en el repo `exercise-plan-builder`: `artifacts/api-server/src/lib/ia-api.ts` (rutas montadas en `/api/ia`).

## Conexión

- CRM (`.env`): `MAIN_APP_URL=https://app.gimnasioelclub.com.ar` y `MAIN_APP_TOKEN=<token>`.
- App de El Club (Secrets de Replit): `CRM_API_TOKEN=<el mismo token>`. Sin ese Secret, las rutas responden 503.
- Header: `Authorization: Bearer <token>`. Solo GET, solo lectura, sin sesión. Nunca devuelven DNI, datos bancarios ni salud.

## Consultas

| Ruta | Parámetros | Devuelve |
|---|---|---|
| `GET /api/ia/resumen` | `sede?` | Activos, por sede, por medio de pago del último cobro, por plan vigente, activos con deuda |
| `GET /api/ia/socios` | `sede, estado (activo/inactivo/todos), medio_pago, plan, alta_desde, alta_hasta, vence_desde, vence_hasta, sin_asistir_dias, con_deuda, limite` | `{ total, mostrados, socios }` |
| `GET /api/ia/sin-renovar` | `mes` (AAAA-MM), `sede?`, `plazo_dias?` (45) | `{ total, bajas, pendientes, socios }` |
| `GET /api/ia/vencimientos` | `desde, hasta, sede?` | `{ total, socios }` con `ya_renovo` |
| `GET /api/ia/altas-bajas` | `desde, hasta, sede?, plazo_dias?` | Altas, bajas, cancelaciones con detalle |
| `GET /api/ia/socio` | `q` (nombre, DNI o teléfono) | Hasta 5 fichas con membresías y cobros recientes |

Todas agregan `actualizado` (fecha de cada copia de EVO) y `notas` (cómo interpretar los datos).

## De dónde salen los datos (copias locales de EVO, actualizadas de noche)

- Socios y estado activo: `evo_member_history` (`evo_active`). Teléfono: contactos del perfil (prefiere celular).
- Membresías, vencimientos y cancelaciones: `member_memberships`.
- Baja: misma regla que los reportes — venció y no empezó otra membresía en la misma sede dentro de 45 días; antes de eso es "pendiente".
- Medio de pago: el del **último cobro** recibido/conciliado (`comercial_cache`, tipo `movimientos`, sin anulaciones ni créditos internos). No prueba que el próximo se debite igual.
- Deuda: última copia del padrón de deudores (`comercial_cache`, tipo `debtors`). No figurar no certifica deuda cero.
- Asistencia: `member_attendance_days`.
- Fecha de alta: inscripción en EVO; si falta (≈2.800 casos), la primera membresía.
