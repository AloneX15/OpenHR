# Documentación de OpenHR

| Documento | Para quién | Contenido |
| --- | --- | --- |
| [Guía de uso](guia-de-uso.md) | Personas usuarias | Cómo fichar, pedir ausencias, repartir nóminas y exportar, por rol |
| [Despliegue](despliegue.md) | Quien instala | Docker Compose, variables de entorno, HTTPS, copias de seguridad, actualizaciones |
| [Migración desde Factorial](migracion-factorial.md) | Quien instala | Qué se importa por API y cómo |
| [SCIM con Entra ID](scim.md) | Quien instala | Altas y bajas automáticas de cuentas desde Microsoft Entra ID |
| [Despliegue en Azure](despliegue-azure.md) | Quien instala | Terraform: Container Apps, PostgreSQL privado, Blob Storage con identidad gestionada |
| [Arquitectura](arquitectura.md) | Desarrollo | Piezas, módulos, flujo de una petición y decisiones |
| [Base de datos](base-de-datos.md) | Desarrollo | Roles, RLS, diagrama entidad-relación, todas las tablas, funciones y migraciones |
| [API](api.md) | Desarrollo e integraciones | Todos los endpoints con sus permisos |
| [Seguridad](seguridad.md) | Todo el mundo | Modelo de amenazas, controles y auditoría de noviembre de 2026 |
| [Diseño](diseno.md) | Desarrollo y diseño | Paleta azul marino y celeste, temas, iconos y reglas de accesibilidad |
| [Desarrollo](desarrollo.md) | Desarrollo | Entorno local, tests y convenciones |

Decisiones de arquitectura (ADR):

- [0001 · Aislamiento entre organizaciones con RLS](adr/0001-tenancy-rls.md)
- [0002 · Registro de jornada inmutable con cadena de hashes](adr/0002-time-entry-hash-chain.md)
- [0003 · Sesiones con JWT revocables](adr/0003-sesiones.md)
