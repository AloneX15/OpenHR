# OpenHR

Gestión de personas para grupos de empresas en España: quién trabaja dónde, cuándo trabaja, cuándo falta y qué documentos recibe, cumpliendo el registro de jornada.

## Organización

**Organización**:
El grupo de empresas que usa una instalación de OpenHR y cuyos datos están aislados de cualquier otra. En el código, `tenant`.
_Avoid_: Cliente, cuenta, holding (como término técnico)

**Sociedad**:
Persona jurídica con CIF propio dentro de la organización; es quien contrata y quien firma las nóminas.
_Avoid_: Empresa (ambiguo con organización), compañía, entidad

**Centro de trabajo**:
Lugar físico de una sociedad donde se presta el trabajo; fija la zona horaria y los festivos locales.
_Avoid_: Oficina, sede (salvo como nombre de un centro concreto)

**Departamento**:
Agrupación organizativa de relaciones laborales dentro de una sociedad.
_Avoid_: Área, equipo

**Festivo**:
Día no laborable que aplica a toda la organización, a una sociedad o a un centro de trabajo.
_Avoid_: Fiesta, día libre

## Personas

**Persona**:
Ser humano identificado por su DNI/NIE, con independencia de para cuántas sociedades trabaje.
_Avoid_: Empleado (para la persona en sí), trabajador, usuario

**Relación laboral**:
Vínculo de una persona con una sociedad durante un periodo, con su puesto, jornada teórica y responsable. Una persona puede tener varias en el grupo. En el código, `employment`.
_Avoid_: Contrato, alta, ficha

**Empleado/a**:
Persona con al menos una relación laboral vigente.
_Avoid_: Trabajador, colaborador

**Responsable**:
Relación laboral a la que reporta directamente otra relación laboral; aprueba sus ausencias no sensibles.
_Avoid_: Jefe, mánager, supervisor

**Cuenta**:
Acceso de una persona a OpenHR, identificado por su email.
_Avoid_: Usuario (como sinónimo de persona), login

**RR. HH.**:
Permiso de gestión de personas sobre una o todas las sociedades de la organización.
_Avoid_: HR, recursos humanos (como rol), gestor

**Administración**:
Permiso sobre toda la organización: sociedades, tipos de ausencia y permisos de otras cuentas.
_Avoid_: Superadmin, propietario

## Jornada

**Jornada teórica**:
Minutos que una relación laboral debe trabajar cada día de la semana según su horario, antes de descontar festivos y ausencias.
_Avoid_: Horario contratado, horas previstas

**Fichaje**:
Registro de un instante de entrada, salida, inicio de pausa o fin de pausa de una relación laboral.
_Avoid_: Marcaje, check-in, registro (a secas)

**Fichaje manual**:
Fichaje declarado a posteriori, con motivo, porque no se registró en su momento.
_Avoid_: Fichaje editado, corrección (a secas)

**Anulación**:
Evento que deja sin efecto un fichaje anterior, con motivo, sin borrarlo.
_Avoid_: Borrado, eliminación, edición

**Registro de jornada**:
Conjunto de fichajes vigentes por persona y día que exige el art. 34.9 del Estatuto de los Trabajadores.
_Avoid_: Control horario (como documento), parte de horas

**Sello**:
Huella del registro de jornada de una sociedad en un momento dado, enviada fuera del sistema para poder demostrar que no se ha alterado.
_Avoid_: Firma, checkpoint, backup

**Incidencia**:
Anomalía en el registro de un día, como una salida que falta o un fichaje fuera de secuencia.
_Avoid_: Error, alerta

## Ausencias

**Ausencia**:
Periodo en el que una relación laboral no trabaja por un motivo reconocido (vacaciones, permiso, baja).
_Avoid_: Falta (connotación disciplinaria), permiso (como término general)

**Tipo de ausencia**:
Motivo de una ausencia con sus reglas: retribuida o no, si descuenta vacaciones, si necesita aprobación y si es sensible.
_Avoid_: Categoría, concepto

**Ausencia sensible**:
Ausencia cuyo motivo es un dato de salud o familiar que el responsable no puede ver.
_Avoid_: Ausencia privada, confidencial

**Saldo de vacaciones**:
Días de vacaciones que corresponden a una relación laboral en un año, prorrateados por su alta, más ajustes, menos los aprobados y pendientes.
_Avoid_: Bolsa de vacaciones, días restantes

**Ajuste de saldo**:
Corrección manual del saldo de vacaciones de un año, con motivo.
_Avoid_: Regularización

## Documentos

**Documento**:
Fichero publicado para una persona en «Mis documentos».
_Avoid_: Archivo, adjunto

**Lote de nóminas**:
PDF con todas las nóminas de una sociedad para un mes, que se reparte página a página.
_Avoid_: Remesa, batch

**Revisión de página**:
Decisión humana de a qué persona corresponde una página de un lote, o de que no es una nómina.
_Avoid_: Validación, asignación automática

**Acuse de lectura**:
Constancia de la primera descarga de un documento por la propia persona; no equivale a firma.
_Avoid_: Firma, confirmación

**Variables de nómina**:
Datos del mes por relación laboral (días, horas y ausencias) que la gestoría necesita para calcular la nómina.
_Avoid_: Incidencias de nómina, novedades

## Encuestas

**Encuesta**:
Conjunto de preguntas que RR. HH. lanza a la plantilla de una sociedad o de todo el grupo; puede ser anónima o con nombre.
_Avoid_: Formulario, cuestionario (como término técnico)

**eNPS**:
Índice de recomendación de la empresa como lugar de trabajo: porcentaje de promotores (9–10) menos porcentaje de detractores (0–6), de −100 a +100.
_Avoid_: NPS (es el de clientes)

## Gastos

**Gasto**:
Importe que una persona adelanta por trabajo (ticket o kilometraje) y que la sociedad le reembolsa con la nómina tras aprobarlo el responsable y RR. HH. En el código, `expense`.
_Avoid_: Nota de gastos, dieta (salvo como categoría), reembolso (es el resultado, no el gasto)

**Justificante**:
Foto o PDF del ticket o factura que acredita un gasto.
_Avoid_: Recibo, comprobante

**Abonado**:
Gasto aprobado que ya se ha incluido en la nómina de un mes concreto.
_Avoid_: Pagado, liquidado
