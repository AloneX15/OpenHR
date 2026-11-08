# Diseño de la interfaz

## Identidad

Factorial usa colores cálidos (coral y rosa). OpenHR va al lado opuesto: **azul marino** como color de marca, para transmitir confianza y seriedad, y **celeste** como acento para lo activo y lo interactivo.

## Paleta

Todos los colores son variables CSS en `apps/web/src/app/globals.css`. Los componentes nunca usan hexadecimales directos.

| Token | Claro | Oscuro | Uso |
| --- | --- | --- | --- |
| `--bg` | `#f3f7fb` | `#06111f` | Fondo de página |
| `--surface` | `#ffffff` | `#0c1b2e` | Tarjetas, modales |
| `--surface-2` | `#e9f1f9` | `#12253d` | Fondos secundarios, filas inactivas |
| `--border` | `#d3e0ed` | `#1e3654` | Bordes |
| `--text` | `#0b1f3a` | `#e4eef9` | Texto principal |
| `--muted` | `#4b627c` | `#93abc5` | Texto secundario |
| `--primary` | `#0f2d5c` (marino) | `#5cc4f2` (celeste) | Botón principal |
| `--on-primary` | `#ffffff` | `#06172d` | Texto sobre el botón principal |
| `--accent` | `#0b6fa8` | `#6ccbf4` | Enlaces, pestaña activa |
| `--accent-strong` | `#38a8dd` | `#5cc4f2` | Subrayados y barras |
| `--primary-soft` | `#dff0fb` | `#0f2c48` | Avisos informativos, insignias |
| `--focus` | `#2b9bd6` | `#6ccbf4` | Anillo de foco |
| `--sidebar-bg` | `#0b1f3a` | `#050e1a` | Menú lateral (marino en ambos temas) |
| `--sidebar-active-text` | `#7fd0f5` | `#7fd0f5` | Elemento activo del menú (celeste) |
| `--success` / `--warning` / `--danger` | `#12704a` / `#8a5300` / `#b42318` | `#4cc78d` / `#f0b453` / `#f4796f` | Estados |

Contraste: el texto normal cumple al menos 4,5:1 sobre su fondo en ambos temas (WCAG AA) y los controles y anillos de foco, 3:1. El estado nunca se comunica solo con color: las insignias llevan texto.

## Temas

Claro, Oscuro o **Sistema** (sigue `prefers-color-scheme`). El selector está en el menú lateral y en **Mi cuenta**. La preferencia se guarda en `localStorage` (`openhr-theme`) y un script en `<head>` la aplica antes de pintar, para evitar el destello del tema equivocado. Técnicamente, «Claro» y «Oscuro» fijan `data-theme` en `<html>`; «Sistema» lo quita.

## Iconos

Iconos animados de [AnimateIcons](https://animateicons.in) (`@animateicons/react`, licencia MIT, basados en Lucide). Se importan uno a uno desde `apps/web/src/components/icons.tsx`, que es el catálogo: para usar uno nuevo, añádelo ahí.

- `useHoverIcon(nombre)` anima el icono cuando el ratón o el foco del teclado entran en el enlace o botón que lo contiene, no solo en el dibujo.
- `IconButton` es un botón con icono animado.
- Si la persona tiene activado «reducir movimiento», los iconos no se animan (lo respeta la librería y el CSS global).
- Los iconos son decorativos (`aria-hidden`); el texto del botón o una etiqueta `aria-label` da el significado.

## Reglas de usabilidad y accesibilidad

Basadas en la guía de la skill *UI/UX Pro Max*:

- Foco visible de 2 px en todos los elementos interactivos y enlace «Saltar al contenido».
- Objetivos táctiles de al menos 44 px en móvil; 36 px en escritorio para botones.
- Campos con etiqueta visible (nunca solo placeholder), pista debajo y errores con `role="alert"`.
- Texto de 16 px en los campos en móvil (evita el zoom de iOS); interlineado 1,5.
- Transiciones de 100-150 ms solo en color, fondo y escala; nada se anima con `prefers-reduced-motion`.
- Cifras con `tabular-nums` en tablas y contadores.
- Diseño responsive: el menú lateral pasa a cajón por debajo de 860 px.
- Acciones destructivas con confirmación (anular fichajes, dar de baja, descartar un lote).
- Estados vacíos con un texto que explica qué hacer.
