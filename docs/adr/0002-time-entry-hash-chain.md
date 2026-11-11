# ADR 0002 · Registro de jornada inmutable con cadena de hashes

Estado: aceptada · 2026-11-08

## Contexto

El registro de jornada (art. 34.9 ET) debe ser fiable y conservarse cuatro años. La Inspección valora que no pueda manipularse a posteriori. Al mismo tiempo, el RGPD obliga a borrar o anonimizar los datos cuando vence el plazo.

## Decisión

- `time_entry` es **append-only**: el rol de aplicación solo tiene `SELECT` e `INSERT`, y un trigger impide `UPDATE`, `DELETE` y `TRUNCATE` incluso al propietario.
- Una corrección es un evento nuevo: `source = 'manual'` para un fichaje olvidado, o `kind = 'void'` para anular otro. Ambos exigen motivo y guardan quién lo hizo. El fichaje anulado sigue visible, tachado.
- En fichajes en tiempo real vale la hora del servidor; la del dispositivo se guarda solo como información.
- Cada relación laboral tiene su propia cadena: `hash = sha256(prev_hash | content_digest)`, donde `content_digest` es el SHA-256 del contenido canónico del evento. La cabeza (`time_chain_head`, `time_chain_seq`) vive en `employment` y se actualiza con un bloqueo de fila, que serializa solo los fichajes de una misma persona.
- Quien controla la base de datos podría recalcular toda la cadena. Por eso existen los **sellos**: una huella de todas las cabezas de una sociedad que se envía por email a RR. HH. y queda fuera del sistema.

## Retención (implementada en la migración 012)

Como el hash encadena el *digest* y no el contenido, se pueden anonimizar los datos personales de un evento (por ejemplo, el motivo) sin romper los enlaces de la cadena; solo deja de poder comprobarse el contenido de ese evento. Para purgar periodos completos se guardará un punto de control con el último hash del periodo purgado, de forma que la verificación empiece en él. La purga la hace `retention_purge_time_entries()`: guarda en `time_chain_checkpoint` el último eslabón purgado de cada relación laboral, borra los anteriores (el trigger solo lo permite dentro de esa función) y la verificación empieza en el punto de control.

## Sellado automático y sello de tiempo (migración 022)

- Al empezar cada mes, la API sella el mes anterior de cada sociedad con fichajes (`SealScheduler`). Un índice único por sociedad y mes evita sellos automáticos duplicados aunque haya varias réplicas.
- El email demuestra el sello mientras alguien conserve el correo, y lo envía el propio sistema. Con `TSA_URL`, la huella lleva además un sello de tiempo RFC 3161: lo firma un tercero y se verifica sin confiar en OpenHR. La respuesta de la TSA se guarda tal cual en `time_chain_seal.tsa_response`.
- Si la TSA falla, se sella sin sello de tiempo: es mejor un sello por email que ninguno.
- El fichaje sin conexión (hora declarada frente a hora recibida) llegó en la migración 015.
