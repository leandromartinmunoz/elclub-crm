# Asistente — API de solo lectura que tiene que exponer la app de El Club (Replit)

El asistente del CRM le hace preguntas a Claude, y Claude pide datos a la app de El Club a través de estas consultas.
Todas son **GET**, **solo lectura** y responden **JSON**.

## Reglas comunes

- Base: `https://app.gimnasioelclub.com.ar` (variable `MAIN_APP_URL` del CRM).
- Autenticación: header `Authorization: Bearer <token>`. El token es el mismo `MAIN_APP_TOKEN` que usa la ficha del socio (`/api/crm/socio`). En Replit se guarda como Secret `CRM_API_TOKEN`. Sin token o con token incorrecto → **401**.
- Si no hay resultados, responder **200** con `total: 0` (nunca 404: el CRM interpreta 404 como "esta consulta todavía no existe").
- Fechas `AAAA-MM-DD`, meses `AAAA-MM`, zona horaria de Córdoba.
- `sede` (opcional en todas): filtra por nombre de sede, sin distinguir mayúsculas. Sin `sede` = todas.
- Listas de socios: cada socio con estos campos (los que la app tenga; los que falten van `null`):
  ```json
  { "id": 123, "nombre": "Juana Pérez", "telefono": "5493547...", "sede": "Sarmiento", "plan": "Musculación libre",
    "estado": "activo", "medio_pago": "debito_automatico", "fecha_alta": "2026-08-14",
    "vencimiento": "2026-12-10", "ultima_asistencia": "2026-11-09", "deuda": 0 }
  ```
  **No incluir DNI ni datos bancarios** en las listas.
- `estado`: `activo` (cuota al día), `vencido` (venció y no pagó, pero no se dio de baja), `baja`.
- `medio_pago`: usar siempre los mismos valores en minúscula y sin espacios: `debito_automatico`, `efectivo`, `transferencia`, `tarjeta`, `mercadopago`, `otro`.

## Consultas

| Ruta | Parámetros | Devuelve |
|---|---|---|
| `GET /api/ia/resumen` | `sede?` | `{ activos, por_sede: {nombre: n}, por_medio_pago: {valor: n}, por_plan: {nombre: n}, sedes: [..], planes: [..] }` (solo socios activos) |
| `GET /api/ia/socios` | `sede?`, `estado?` (activo por defecto, o `todos`), `medio_pago?`, `plan?` (contiene, sin mayúsculas), `alta_desde?`, `alta_hasta?`, `sin_asistir_dias?`, `con_deuda?` (`true`/`false`), `limite?` (50 por defecto, máx. 500) | `{ total, socios: [...] }` — `total` es el total real aunque la lista se corte en `limite` |
| `GET /api/ia/sin-renovar` | `mes` (obligatorio), `sede?` | `{ total, socios: [... + "ultimo_pago": "AAAA-MM-DD", "vencio_el": "AAAA-MM-DD"] }` — socios cuyo período venció en ese mes y que no pagaron uno nuevo después |
| `GET /api/ia/vencimientos` | `desde`, `hasta` (obligatorios), `sede?` | `{ total, socios: [...] }` — socios activos cuya cuota vence entre esas fechas, ordenados por vencimiento |
| `GET /api/ia/altas-bajas` | `desde`, `hasta` (obligatorios), `sede?` | `{ altas, bajas, detalle_altas: [...], detalle_bajas: [... + "fecha_baja", "motivo"] }` |
| `GET /api/ia/socio` | `q` (nombre, DNI o teléfono) | `{ coincidencias: [ {...socio, "pagos": [{fecha, monto, medio_pago, periodo}] (últimos 6), "asistencias_ultimo_mes": n } ] }` (máx. 5 coincidencias) |

Las consultas se pueden ir creando de a una: las que todavía no existan, el asistente avisa que no están disponibles.

---

## Prompt para el Agent de Replit

Copiar y pegar tal cual:

> Necesito una API de **solo lectura** para el asistente del CRM de El Club. No modifiques ninguna tabla ni lógica existente: solo agregá rutas nuevas.
>
> 1. Protegé todas las rutas nuevas bajo `/api/ia/` con el header `Authorization: Bearer <token>`, comparándolo de forma segura (timing-safe) con el Secret `CRM_API_TOKEN` (si ya existe por `/api/crm/socio`, usá el mismo). Sin token o incorrecto → 401. Si el Secret no está cargado → 503.
> 2. Creá estas rutas GET, que responden JSON, en zona horaria America/Argentina/Cordoba, fechas `AAAA-MM-DD`. Si no hay resultados, 200 con `total: 0` (nunca 404):
>    - `/api/ia/resumen?sede=` → `{ activos, por_sede, por_medio_pago, por_plan, sedes, planes }` (solo socios activos).
>    - `/api/ia/socios?sede=&estado=&medio_pago=&plan=&alta_desde=&alta_hasta=&sin_asistir_dias=&con_deuda=&limite=` → `{ total, socios }`. `estado`: `activo` (por defecto), `vencido`, `baja` o `todos`. `plan` filtra por "contiene", sin distinguir mayúsculas. `limite` 50 por defecto, máximo 500. `total` es el total real aunque la lista se corte.
>    - `/api/ia/sin-renovar?mes=AAAA-MM&sede=` → socios cuyo período venció en ese mes y no pagaron otro después. `{ total, socios }`, cada uno con `ultimo_pago` y `vencio_el`.
>    - `/api/ia/vencimientos?desde=&hasta=&sede=` → socios activos cuya cuota vence entre esas fechas, ordenados por vencimiento. `{ total, socios }`.
>    - `/api/ia/altas-bajas?desde=&hasta=&sede=` → `{ altas, bajas, detalle_altas, detalle_bajas }` (las bajas con `fecha_baja` y `motivo` si existe).
>    - `/api/ia/socio?q=` → busca por nombre, DNI o teléfono, máximo 5: `{ coincidencias }`, cada una con los datos del socio, sus últimos 6 pagos (`fecha, monto, medio_pago, periodo`) y `asistencias_ultimo_mes`.
> 3. Cada socio en las listas lleva: `id, nombre, telefono, sede, plan, estado, medio_pago, fecha_alta, vencimiento, ultima_asistencia, deuda` (los que no existan, `null`). **No incluyas DNI ni datos bancarios en las listas.**
> 4. `medio_pago` siempre normalizado a: `debito_automatico`, `efectivo`, `transferencia`, `tarjeta`, `mercadopago` u `otro`.
> 5. `sede` filtra por nombre sin distinguir mayúsculas; sin `sede`, todas.
> 6. Validá los parámetros (fechas, números) y devolvé 400 con un mensaje claro si son inválidos. Usá consultas parametrizadas.
> 7. Agregá pruebas para: 401 sin token, un filtro por medio de pago, y sin-renovar de un mes.
> 8. Al terminar, decime qué campos no pudiste completar porque la base no los tiene (por ejemplo medio de pago, fecha de alta o asistencias).
