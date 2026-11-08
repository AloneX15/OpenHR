# Migración desde Factorial

OpenHR importa los datos de Factorial con su **API pública** (versión `2026-10-01`, https://apidoc.factorialhr.com), sin depender de exportaciones manuales. Los nombres de los campos se han comprobado en la especificación OpenAPI oficial de esa versión.

## Qué se importa

| Factorial | OpenHR | Notas |
| --- | --- | --- |
| Entidades legales (`companies/legal_entities`) | Sociedades | Se enlazan por CIF (`tin`) si ya existen |
| Centros (`locations/locations`) | Centros de trabajo | Con su zona horaria; se crean en la sociedad de cada persona |
| Equipos (`teams/teams`) | Departamentos | El primer equipo de cada persona |
| Personas (`employees/employees`) | Personas y relaciones laborales | Nombre, DNI/NIE (si es válido), email, teléfono, nacimiento, sexo, fecha de baja; responsable (`manager_id`) |
| Versiones de contrato (`contracts/contract_versions`) | Puesto, jornada semanal, fecha de alta y, opcionalmente, retribución | Horas por semana, día, mes o año; salario anual o mensual (en céntimos) |
| Tipos de ausencia y ausencias aprobadas (`timeoff/*`) | Tipos y ausencias aprobadas | Vacaciones, asuntos propios, baja… se asocian a los tipos de OpenHR por nombre; el resto se crean. Las pendientes y rechazadas no se importan |
| Fichajes (`attendance/shifts`) | Registro de jornada | Desde la fecha que elijas. Cada tramo es una entrada y una salida (las pausas, inicio y fin de pausa), con origen «importado» y en la cadena de hashes. Los tramos sin salida se omiten |

No se importan documentos, nóminas en PDF ni datos bancarios.

## Cómo se hace

1. En Factorial, con una cuenta de administración: **Ajustes → Claves de API → Nueva clave**. Cópiala (solo se muestra una vez).
2. En OpenHR: **Organización → Migrar desde Factorial**. Pega la clave y elige el entorno (producción o la demo de Factorial).
3. Pulsa **Simular**: lee todo y cuenta lo que importaría, con avisos (por ejemplo, documentos que no son DNI/NIE válidos), sin escribir nada.
4. Pulsa **Migrar**. Se ejecuta en segundo plano; la pantalla muestra el progreso y el resultado.
5. **Borra la clave en Factorial** al terminar. OpenHR no la guarda en ningún sitio.

Se puede repetir: una tabla de correspondencias (`migration_mapping`) evita duplicados, actualiza bajas y puestos, y los fichajes llevan una clave de idempotencia por tramo.

## Después de migrar

- Revisa en **Equipo** que cada persona tiene su sociedad, centro y responsable.
- Invita a las personas desde su ficha (o pon el email y usa «Crear cuenta e invitar»).
- Comprueba los tipos de ausencia creados en **Organización → Tipos de ausencia**.
- Carga los festivos locales de cada centro.

## Detalles técnicos

- Cliente: `apps/api/src/migration/factorial-client.ts`. Cabecera `x-api-key`, paginación por cursor (`limit=100`, `after_id = meta.end_cursor`) y reintentos con espera 2, 4, 8 y 16 s en respuestas 429 y 5xx.
- Solo se llama a `api.factorialhr.com` o a la demo `api.eu2.demo.factorial.dev` (la API de OpenHR no acepta otras direcciones).
- Cada ejecución queda en `migration_job` con recuentos y registro, sin la clave.
- Probado con un servidor falso que imita las respuestas de Factorial (`apps/api/test/integration.test.ts`). Aún no se ha probado contra una cuenta real: haz primero la simulación.
