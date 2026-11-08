# Aprovisionamiento con SCIM (Microsoft Entra ID)

OpenHR implementa un servidor SCIM 2.0 ([RFC 7643](https://www.rfc-editor.org/rfc/rfc7643) y [RFC 7644](https://www.rfc-editor.org/rfc/rfc7644)) para que el directorio de la empresa gestione las **cuentas de acceso**:

- Cuando asignas la aplicación OpenHR a alguien en Entra ID, se crea su cuenta.
- Cuando deja la empresa o le quitas la aplicación, la cuenta se desactiva y sus sesiones abiertas se cierran al instante.

La **ficha laboral** (sociedad, centro, contrato, jornada) no viene del directorio: la sigue dando de alta RR. HH. en OpenHR. Si la persona ya tiene ficha con el mismo email, la cuenta se vincula al crearla. Si la cuenta llega antes, se vincula en cuanto RR. HH. da de alta la ficha con ese email, y no se manda invitación porque la persona entra con su cuenta corporativa.

## Configuración en Entra ID

1. Configura antes el [inicio de sesión con Microsoft 365](guia-de-uso.md#administración) (OpenID Connect). Con SCIM las personas no tienen contraseña de OpenHR.
2. En OpenHR: **Organización → Inicio de sesión → Aprovisionamiento automático (SCIM)** → *Generar token*. Copia la URL del inquilino (`https://tu-openhr/api/scim/v2`) y el token: solo se muestra una vez.
3. En Entra ID: **Aplicaciones empresariales** → tu aplicación OpenHR (o *Nueva aplicación → Cree su propia aplicación → Integrar cualquier otra aplicación*) → **Aprovisionamiento** → modo **Automático**.
4. Pega la URL del inquilino y el token secreto, y pulsa **Probar conexión**.
5. En **Asignaciones**, desactiva el aprovisionamiento de grupos y deja para los usuarios:

   | Atributo de Entra ID | Atributo de OpenHR |
   | --- | --- |
   | `userPrincipalName` (o `mail`) | `userName` |
   | `Switch([IsSoftDeleted], , "False", "True", "True", "False")` | `active` |
   | `objectId` | `externalId` |
   | `givenName` | `name.givenName` |
   | `surname` | `name.familyName` |

   El resto de atributos se pueden quitar: OpenHR los ignora.
6. Asigna los usuarios o grupos que deben tener OpenHR y activa el aprovisionamiento.

## Qué hace cada operación

| Operación | Efecto en OpenHR |
| --- | --- |
| `POST /Users` | Crea la cuenta (sin contraseña). La vincula a la persona con ese email si existe. Si el email ya tiene cuenta, `409 uniqueness` |
| `GET /Users?filter=userName eq "…"` o `externalId eq "…"` | Busca la cuenta (es lo que hace Entra ID antes de crear) |
| `PATCH /Users/:id` | Cambia email, `externalId` o `active`. Los nombres solo se completan si la ficha no los tiene: los lleva RR. HH. |
| `PUT /Users/:id` | Igual que `PATCH` con todos los campos |
| `DELETE /Users/:id` | **Desactiva** la cuenta; no la borra (el registro de jornada y la auditoría deben conservarse) |
| `GET /Groups` | Lista vacía: los roles (RR. HH., administración) se asignan en OpenHR |

Cada alta, desactivación y reactivación queda en la auditoría.

## Seguridad

- El token es de la organización; solo se guarda su huella SHA-256. Puedes tener varios y revocarlos en cualquier momento.
- Las respuestas siguen el formato de error de SCIM y nunca indican si un email existe en otra organización de la misma instalación.
- SCIM no puede dar permisos: una cuenta creada así es una cuenta normal de empleado.
