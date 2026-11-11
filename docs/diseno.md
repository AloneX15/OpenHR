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

### Degradados

Los botones de acción usan degradados que salen del tono del tema, definidos como variables: `--btn-gradient` (botón principal: marino en claro, celeste en oscuro), `--accent-gradient` (fichaje, barras de progreso), `--success-gradient` y `--danger-gradient`. El texto encima usa `--on-primary`, `--on-success` y `--on-danger`. Al pasar el ratón, un brillo cruza el botón. El fondo de la página lleva un resplandor celeste muy suave (`--page-glow`).

Los tipos de ausencia y de turno comparten colores: las clases `tone-sky`, `tone-teal`, `tone-violet`… fijan `--c`, que pintan barras, puntos y días del calendario. Las vacaciones son siempre `teal`; el resto de tipos recibe un color estable calculado con su nombre (`absenceTone` en `components/Events.tsx`).

## Temas

Claro, Oscuro o **Sistema** (sigue `prefers-color-scheme`). El selector está en el menú lateral y en **Mi cuenta**. La preferencia se guarda en `localStorage` (`openhr-theme`) y un script en `<head>` la aplica antes de pintar, para evitar el destello del tema equivocado. Técnicamente, «Claro» y «Oscuro» fijan `data-theme` en `<html>`; «Sistema» lo quita.

## Iconos

Iconos animados de [AnimateIcons](https://animateicons.in) (`@animateicons/react`, licencia MIT, basados en Lucide). Se importan uno a uno desde `apps/web/src/components/icons.tsx`, que es el catálogo: para usar uno nuevo, añádelo ahí.

- `useHoverIcon(nombre)` anima el icono cuando el ratón o el foco del teclado entran en el enlace o botón que lo contiene, no solo en el dibujo.
- `IconButton` es un botón con icono animado.
- Si la persona tiene activado «reducir movimiento», los iconos no se animan (lo respeta la librería y el CSS global).
- Los iconos son decorativos (`aria-hidden`); el texto del botón o una etiqueta `aria-label` da el significado.

## Distribución y móvil

- **Menú lateral** agrupado por para quién es cada cosa: *Mi espacio*, *Empresa* y *Gestión*. Cada grupo se pliega y recuerda su estado. La cuenta (mi cuenta, privacidad, cerrar sesión) está en el menú del pie.
- **Por debajo de 860 px** el menú pasa a cajón y aparece una **barra inferior** con Inicio, Horario, Ausencias y Más. En el centro, el **botón de fichar**: cambia de color según el estado (fuera, trabajando, en pausa) y abre el fichaje sin salir de la pantalla.
- En móvil las **ventanas suben desde abajo** y sus botones ocupan todo el ancho, al alcance del pulgar. Las tablas anchas se desplazan de lado dentro de su tarjeta; la hoja de fichajes y las ausencias pasan a tarjetas.
- **Inicio**: saludo, «Requiere tu atención», anuncios y notificaciones; a la derecha (arriba en móvil) el fichaje con la barra del día, el saldo de vacaciones y lo próximo.
- **Ausencias**: saldo, próximas y anteriores a la izquierda; a la derecha, el año completo con ausencias, festivos y hoy. Pulsar un día libre abre la solicitud en esa fecha.
- **Hoja de fichajes**: totales del periodo y una fila por día con la barra de trabajo y pausas; al pulsarla se despliegan sus fichajes.

## Desplegables

- `<select>` nativo, con la flecha dibujada con el color del tema: en formularios. En móvil abre el selector del sistema, que es lo más cómodo.
- `Select` (`components/ui.tsx`): desplegable propio para elegir entre pocas opciones a la vista (sociedad, periodo). Flechas, Inicio, Fin, Intro y Escape funcionan.
- `Menu`: acciones secundarias detrás de un botón (por ejemplo «…» en la hoja de fichajes).
- `Collapse`: contenido que se pliega en altura (grupos del menú, días de la hoja de fichajes).
- `Segmented` y `Stepper`: cambiar de vista y moverse por semanas, meses o años.

## Movimiento

Las animaciones usan [GSAP](https://gsap.com) y viven en `apps/web/src/lib/motion.ts`; los componentes no llaman a GSAP directamente.

| Qué | Cómo |
| --- | --- |
| Cambio de página | Los bloques entran escalonados (`useStagger`) |
| Desplegables y menús | Crecen desde su origen y sus opciones entran en cascada (`usePopIn`) |
| Plegar y desplegar | Altura animada (`useCollapse`) |
| Ventanas | Se acercan en escritorio; suben desde abajo en móvil (`useModalIn`) |
| Barras de progreso | Crecen desde la izquierda al cargar (`useGrow`) |
| Botones | Se hunden al pulsar y vuelven con un rebote corto (`installPressFeedback`) |

Reglas: el movimiento acompaña a una acción de la persona, dura menos de medio segundo y nunca bloquea. Con «reducir movimiento» activado no se anima nada. GSAP solo escribe estilos en línea, así que es compatible con la política de seguridad de contenidos con nonces.

Licencia: GSAP se distribuye con su «Standard License» gratuita, que no es una licencia de software libre. OpenHR lo usa como dependencia de npm sin modificarlo.

## Reglas de usabilidad y accesibilidad

Basadas en la guía de la skill *UI/UX Pro Max*:

- Foco visible de 2 px en todos los elementos interactivos y enlace «Saltar al contenido».
- Objetivos táctiles de al menos 44 px en móvil (botones y campos, 46 px); 38 px en escritorio para botones.
- Campos con etiqueta visible (nunca solo placeholder), pista debajo y errores con `role="alert"`.
- Texto de 16 px en los campos en móvil (evita el zoom de iOS); interlineado 1,5.
- Transiciones de 100-150 ms en color, fondo y borde; el resto del movimiento sigue las reglas de «Movimiento»; nada se anima con `prefers-reduced-motion`.
- Cifras con `tabular-nums` en tablas y contadores.
- Diseño responsive: ver «Distribución y móvil». Ninguna pantalla tiene desplazamiento horizontal de página a 390 px.
- Acciones destructivas con confirmación (anular fichajes, dar de baja, descartar un lote).
- Estados vacíos con un texto que explica qué hacer.
