'use client';

import { IconButton } from '@/components/icons';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { ApprovalFlows } from '@/components/Approvals';
import { EmployeeForm, emptyEmployee } from '@/components/EmployeeForm';
import { FactorialMigration } from '@/components/FactorialMigration';
import { OidcSettings } from '@/components/OidcSettings';
import { ChatIntegrations } from '@/components/ChatIntegrations';
import { ScimTokens } from '@/components/ScimTokens';
import { GeoFields, KioskDevices } from '@/components/Kiosk';
import { ChecklistTemplatesAdmin, CustomFieldsAdmin } from '@/components/Lifecycle';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { dayLabel, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'personas' | 'sociedades' | 'centros' | 'festivos' | 'ausencias' | 'aprobaciones' | 'checklists' | 'campos' | 'migracion' | 'acceso' | 'integraciones';

export default function OrganizationPage() {
  const { me } = useSession();
  const [tab, setTab] = useState<Tab>('personas');
  return (
    <>
      <PageHeader title="Organización" subtitle="Sociedades, centros, calendario laboral y altas de personas." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'personas', label: 'Altas e importación' },
          { id: 'sociedades', label: 'Sociedades' },
          { id: 'centros', label: 'Centros y departamentos' },
          { id: 'festivos', label: 'Festivos' },
          { id: 'ausencias', label: 'Tipos de ausencia' },
          { id: 'aprobaciones', label: 'Circuitos de aprobación' },
          { id: 'checklists', label: 'Checklists' },
          { id: 'campos', label: 'Campos personalizados' },
          ...(me.isAdmin ? [{ id: 'acceso' as Tab, label: 'Inicio de sesión' }, { id: 'integraciones' as Tab, label: 'Integraciones' }, { id: 'migracion' as Tab, label: 'Migrar desde Factorial' }] : []),
        ]}
      />
      {tab === 'personas' && <People />}
      {tab === 'sociedades' && <Companies isAdmin={me.isAdmin} />}
      {tab === 'centros' && <Centers />}
      {tab === 'festivos' && <Holidays isAdmin={me.isAdmin} />}
      {tab === 'ausencias' && <AbsenceTypes isAdmin={me.isAdmin} />}
      {tab === 'aprobaciones' && <ApprovalFlows isAdmin={me.isAdmin} />}
      {tab === 'checklists' && <ChecklistTemplatesAdmin />}
      {tab === 'campos' && <CustomFieldsAdmin isAdmin={me.isAdmin} />}
      {tab === 'migracion' && me.isAdmin && <FactorialMigration />}
      {tab === 'acceso' && me.isAdmin && (
        <div className="stack">
          <OidcSettings />
          <ScimTokens />
        </div>
      )}
      {tab === 'integraciones' && me.isAdmin && <ChatIntegrations />}
    </>
  );
}

function People() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  return (
    <div className="grid grid-2">
      <Card title="Alta individual">
        <p className="muted">Da de alta a una persona en una sociedad. Si ya trabaja en otra sociedad del grupo, se reutilizan sus datos de persona por el DNI.</p>
        <IconButton icon="plus" className="btn btn-primary" onClick={() => setCreating(true)}>
          Nueva persona
        </IconButton>
      </Card>
      <ImportCard />
      {creating && (
        <Modal title="Nueva persona" onClose={() => setCreating(false)}>
          <EmployeeForm
            mode="create"
            initial={emptyEmployee()}
            onCancel={() => setCreating(false)}
            onSubmit={async (payload) => {
              const r = await api.post('/org/employees', payload);
              router.push(`/equipo/${r.employmentId}`);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function ImportCard() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const action = useAction();
  const send = (dryRun: boolean) =>
    action.run(async () => {
      const form = new FormData();
      form.set('file', file!);
      setResult(await api.upload(`/imports/employees?dryRun=${dryRun}`, form));
    });
  return (
    <Card title="Importar desde CSV o Excel">
      <p className="muted">
        Para migrar la plantilla de golpe (por ejemplo, exportada de Factorial o de una hoja de cálculo).{' '}
        <button className="btn btn-ghost btn-sm" onClick={() => action.run(() => download('/imports/employees/template'))}>
          Descargar plantilla
        </button>
      </p>
      <ErrorBox error={action.error} />
      <Field label="Fichero CSV (separado por ; o ,) o Excel (.xlsx)">
        <input
          type="file"
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setResult(null);
          }}
        />
      </Field>
      <div className="row">
        <button className="btn" disabled={!file || action.busy} onClick={() => send(true)}>
          1. Validar
        </button>
        <button className="btn btn-primary" disabled={!file || action.busy || !result || result.errors > 0 || !result.dryRun} onClick={() => send(false)}>
          2. Importar
        </button>
      </div>
      {result && (
        <div style={{ marginTop: 12 }}>
          {result.dryRun ? (
            result.errors ? (
              <Notice tone="warning">
                {result.errors} de {result.total} filas tienen errores. Corrígelas y vuelve a validar: no se importa nada hasta que todo esté bien.
              </Notice>
            ) : (
              <Notice tone="success">Las {result.total} filas son correctas. Pulsa «Importar».</Notice>
            )
          ) : (
            <Notice tone="success">Importadas {result.created} personas. Las que tienen email han recibido su invitación.</Notice>
          )}
          <ul className="list small">
            {result.report
              .filter((l: any) => l.errors.length || l.warnings.length)
              .slice(0, 100)
              .map((l: any) => (
                <li key={l.line}>
                  <strong>
                    Fila {l.line} · {l.name}
                  </strong>
                  {l.errors.map((e: string) => (
                    <div key={e} className="text-danger">
                      Error: {e}
                    </div>
                  ))}
                  {l.warnings.map((w: string) => (
                    <div key={w} className="muted">
                      {w}
                    </div>
                  ))}
                </li>
              ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Companies({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/org/companies'));
  const [editing, setEditing] = useState<any | null>(null);
  return (
    <Card
      title="Sociedades del grupo"
      actions={
        isAdmin && (
          <button className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
            Añadir sociedad
          </button>
        )
      }
    >
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Razón social</th>
            <th>CIF</th>
            <th>CCC</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.legal_name}</td>
              <td className="mono">{c.tax_id}</td>
              <td className="mono">{c.ccc ?? '—'}</td>
              <td className="num">
                {isAdmin && (
                  <button className="btn btn-sm" onClick={() => setEditing(c)}>
                    Editar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <CompanyModal company={editing} onClose={() => setEditing(null)} onDone={reload} />}
    </Card>
  );
}

function CompanyModal({ company, onClose, onDone }: { company: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({
    name: company.name ?? '',
    legalName: company.legal_name ?? '',
    taxId: company.tax_id ?? '',
    ccc: company.ccc ?? '',
    address: company.address ?? '',
  });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const body = { ...f, ccc: f.ccc || undefined, address: f.address || undefined };
      if (company.id) await api.patch(`/org/companies/${company.id}`, body);
      else await api.post('/org/companies', body);
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={company.id ? 'Editar sociedad' : 'Nueva sociedad'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Nombre corto">
            <input required value={f.name} onChange={set('name')} />
          </Field>
          <Field label="Razón social">
            <input required value={f.legalName} onChange={set('legalName')} />
          </Field>
          <Field label="CIF">
            <input required value={f.taxId} onChange={set('taxId')} />
          </Field>
          <Field label="Código de cuenta de cotización">
            <input value={f.ccc} onChange={set('ccc')} />
          </Field>
        </div>
        <Field label="Dirección">
          <input value={f.address} onChange={set('address')} />
        </Field>
        {!company.id && <p className="muted small">Se creará con un centro «Sede central» que podrás renombrar.</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

const TIMEZONES = ['Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta', 'Europe/Lisbon', 'Europe/London', 'UTC'];

function Centers() {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const centers = useLoad(() => api.get<any[]>('/org/work-centers'));
  const departments = useLoad(() => api.get<any[]>('/org/departments'));
  const [center, setCenter] = useState<any | null>(null);
  const [dept, setDept] = useState({ companyId: '', name: '' });
  const action = useAction();
  return (
    <div className="grid grid-2">
      <Card
        title="Centros de trabajo"
        actions={
          <button className="btn btn-sm btn-primary" onClick={() => setCenter({ timezone: 'Europe/Madrid' })}>
            Añadir centro
          </button>
        }
      >
        <ErrorBox error={centers.error} />
        <table>
          <thead>
            <tr>
              <th>Centro</th>
              <th>Sociedad</th>
              <th>Zona horaria</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {centers.data?.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.company_name}</td>
                <td className="small">{c.timezone}</td>
                <td className="num">
                  <button className="btn btn-sm" onClick={() => setCenter(c)}>
                    Editar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Departamentos">
        <ErrorBox error={departments.error || action.error} />
        <form
          className="row"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api.post('/org/departments', { companyId: dept.companyId || companies.data?.[0]?.id, name: dept.name });
              setDept({ ...dept, name: '' });
              await departments.reload();
            });
          }}
        >
          <select value={dept.companyId || companies.data?.[0]?.id || ''} onChange={(e) => setDept({ ...dept, companyId: e.target.value })} style={{ width: 'auto' }}>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input required aria-label="Nombre del departamento" placeholder="Nombre del departamento" value={dept.name} onChange={(e) => setDept({ ...dept, name: e.target.value })} style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={action.busy}>
            Añadir
          </button>
        </form>
        {departments.data?.length ? (
          <ul className="list">
            {departments.data.map((d) => (
              <li key={d.id}>
                {d.name} <span className="muted small">· {d.company_name}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Sin departamentos.</Empty>
        )}
      </Card>
      <KioskDevices />
      {center && <CenterModal center={center} companies={companies.data ?? []} onClose={() => setCenter(null)} onDone={centers.reload} />}
    </div>
  );
}

function CenterModal({ center, companies, onClose, onDone }: { center: any; companies: any[]; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({
    companyId: center.company_id ?? companies[0]?.id ?? '',
    name: center.name ?? '',
    timezone: center.timezone ?? 'Europe/Madrid',
    region: center.region ?? '',
    address: center.address ?? '',
    geoPolicy: center.geo_policy ?? 'off',
    latitude: center.latitude ?? null,
    longitude: center.longitude ?? null,
    radiusM: center.radius_m ?? 150,
  });
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const geo = f.geoPolicy === 'off' ? { geoPolicy: 'off' } : { geoPolicy: f.geoPolicy, latitude: f.latitude, longitude: f.longitude, radiusM: f.radiusM };
      const body = { name: f.name, timezone: f.timezone, region: f.region || undefined, address: f.address || undefined, ...geo };
      if (center.id) await api.patch(`/org/work-centers/${center.id}`, body);
      else await api.post('/org/work-centers', { ...body, companyId: f.companyId });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={center.id ? 'Editar centro' : 'Nuevo centro'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorBox error={error} />
        {!center.id && (
          <Field label="Sociedad">
            <select value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Nombre">
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="form-grid">
          <Field label="Zona horaria" hint="Determina a qué día cuenta cada fichaje.">
            <select value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
          </Field>
          <Field label="Comunidad autónoma" hint="Código, p. ej. ES-MD">
            <input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />
          </Field>
        </div>
        <Field label="Dirección">
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <GeoFields value={f} onChange={setF} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Holidays({ isAdmin }: { isAdmin: boolean }) {
  const [year, setYear] = useState(Number(todayIso().slice(0, 4)));
  const holidays = useLoad(() => api.get<any[]>(`/org/holidays?year=${year}`), [year]);
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const centers = useLoad(() => api.get<any[]>('/org/work-centers'));
  const [f, setF] = useState({ date: '', name: '', scope: isAdmin ? 'all' : '' });
  const action = useAction();
  const add = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const [kind, id] = f.scope.split(':');
      await api.post('/org/holidays', {
        date: f.date,
        name: f.name,
        companyId: kind === 'company' ? id : undefined,
        workCenterId: kind === 'center' ? id : undefined,
      });
      setF({ ...f, date: '', name: '' });
      await holidays.reload();
    });
  };
  return (
    <div className="grid grid-2">
      <Card
        title={`Festivos ${year}`}
        actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => setYear(year - 1)}>
              ←
            </button>
            <button className="btn btn-sm" onClick={() => setYear(year + 1)}>
              →
            </button>
          </div>
        }
      >
        <ErrorBox error={holidays.error || action.error} />
        {holidays.data?.length ? (
          <table>
            <tbody>
              {holidays.data.map((h) => (
                <tr key={h.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{dayLabel(h.date)}</td>
                  <td>{h.name}</td>
                  <td>
                    <Badge tone={h.work_center_id ? 'info' : h.company_id ? 'warning' : 'neutral'}>
                      {h.work_center_name ?? h.company_name ?? 'Todo el grupo'}
                    </Badge>
                  </td>
                  <td className="num">
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => confirm('¿Eliminar este festivo?') && action.run(async () => (await api.del(`/org/holidays/${h.id}`), holidays.reload()))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>
            Sin festivos.{' '}
            {isAdmin && (
              <button className="btn btn-sm" onClick={() => action.run(async () => (await api.post(`/org/holidays/national/${year}`), holidays.reload()))}>
                Añadir los nacionales de {year}
              </button>
            )}
          </Empty>
        )}
      </Card>
      <Card title="Añadir festivo">
        <Notice tone="info">Los festivos nacionales se cargan solos. Añade aquí los autonómicos y locales de cada centro (consulta el BOE y el boletín de tu comunidad).</Notice>
        <form onSubmit={add}>
          <div className="form-grid">
            <Field label="Fecha">
              <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </Field>
            <Field label="Nombre">
              <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="San Isidro" />
            </Field>
          </div>
          <Field label="Se aplica a">
            <select required value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}>
              <option value="" disabled>
                Elige…
              </option>
              {isAdmin && <option value="all">Todo el grupo</option>}
              {companies.data?.map((c) => (
                <option key={c.id} value={`company:${c.id}`}>
                  Sociedad: {c.name}
                </option>
              ))}
              {centers.data?.map((c) => (
                <option key={c.id} value={`center:${c.id}`}>
                  Centro: {c.name} ({c.company_name})
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary" disabled={action.busy}>
            Añadir
          </button>
        </form>
      </Card>
    </div>
  );
}

function AbsenceTypes({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, reload } = useLoad(() => api.get<any[]>('/org/absence-types'));
  const action = useAction();
  const [creating, setCreating] = useState(false);
  return (
    <Card
      title="Tipos de ausencia"
      actions={
        isAdmin && (
          <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            Añadir tipo
          </button>
        )
      }
    >
      <p className="muted">Vienen precargados los permisos del Estatuto de los Trabajadores. Si vuestro convenio mejora alguno, añade o ajusta el tipo.</p>
      <ErrorBox error={error || action.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nombre</th>
              <th>Cuenta</th>
              <th>Características</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}>
                <td className="mono">{t.code}</td>
                <td>{t.name}</td>
                <td>{t.day_unit === 'working' ? 'Días laborables' : 'Días naturales'}</td>
                <td>
                  <div className="row" style={{ gap: 4 }}>
                    {t.counts_as_vacation && <Badge tone="info">Descuenta vacaciones</Badge>}
                    {!t.paid && <Badge tone="warning">No retribuido</Badge>}
                    {!t.requires_approval && <Badge>Sin aprobación</Badge>}
                    {t.sensitive && <Badge tone="danger">Dato sensible</Badge>}
                    {t.consumes_hour_bank && <Badge tone="info">Consume bolsa</Badge>}
                  </div>
                </td>
                <td className="num">
                  {isAdmin && (
                    <button className="btn btn-sm" disabled={action.busy} onClick={() => action.run(async () => (await api.patch(`/org/absence-types/${t.id}`, { active: !t.active }), reload()))}>
                      {t.active ? 'Desactivar' : 'Activar'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <AbsenceTypeModal onClose={() => setCreating(false)} onDone={reload} />}
    </Card>
  );
}

function AbsenceTypeModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ code: '', name: '', paid: true, countsAsVacation: false, requiresApproval: true, dayUnit: 'working', sensitive: false, consumesHourBank: false });
  const { busy, error, run } = useAction();
  return (
    <Modal title="Nuevo tipo de ausencia" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.post('/org/absence-types', f);
            await onDone();
            onClose();
          });
        }}
      >
        <ErrorBox error={error} />
        <div className="form-grid">
          <Field label="Código">
            <input required maxLength={10} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
          </Field>
          <Field label="Cuenta en">
            <select value={f.dayUnit} onChange={(e) => setF({ ...f, dayUnit: e.target.value })}>
              <option value="working">Días laborables</option>
              <option value="calendar">Días naturales</option>
            </select>
          </Field>
        </div>
        <Field label="Nombre">
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {(
          [
            ['paid', 'Retribuido'],
            ['countsAsVacation', 'Descuenta del saldo de vacaciones'],
            ['requiresApproval', 'Necesita aprobación'],
            ['sensitive', 'Dato sensible (el responsable no ve el motivo)'],
            ['consumesHourBank', 'Consume la bolsa de horas'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}
          </label>
        ))}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Crear
          </button>
        </div>
      </form>
    </Modal>
  );
}
