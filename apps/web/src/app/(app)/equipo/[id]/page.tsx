'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { EmployeeForm, fromEmployee } from '@/components/EmployeeForm';
import { RequestModal } from '@/components/RequestModal';
import { HourBankCard } from '@/components/HourBankCard';
import { CustomFieldsCard, EmployeeChecklists, TransferModal } from '@/components/Lifecycle';
import { TimeSheet } from '@/components/TimeSheet';
import { Badge, Card, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Tabs, useAction, useLoad } from '@/components/ui';
import { api, download } from '@/lib/api';
import { CATEGORY_LABEL, dateTime, dayLabel, STATUS_LABEL, todayIso } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'ficha' | 'horario' | 'ausencias' | 'documentos' | 'checklists';

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const emp = useLoad(() => api.get(`/org/employees/${id}`), [id]);
  const [tab, setTab] = useState<Tab>('ficha');
  const e = emp.data;
  if (!e) return <ErrorBox error={emp.error} />;
  const isHr = me.isAdmin || me.hrCompanyIds === null ? me.isHr : me.hrCompanyIds.includes(e.company_id);

  return (
    <>
      <PageHeader
        title={`${e.first_name} ${e.last_name}`}
        subtitle={
          <>
            <Link href="/equipo">← Equipo</Link> · {e.job_title ?? 'Sin puesto'} · {e.company_name}
            {e.end_date && <> · <Badge tone="danger">Baja el {e.end_date}</Badge></>}
          </>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'ficha', label: 'Ficha' },
          { id: 'horario', label: 'Control horario' },
          { id: 'ausencias', label: 'Ausencias' },
          { id: 'checklists', label: 'Checklists' },
          ...(isHr ? [{ id: 'documentos' as Tab, label: 'Documentos' }] : []),
        ]}
      />
      {tab === 'ficha' && <Profile e={e} isHr={isHr} isAdmin={me.isAdmin} reload={emp.reload} />}
      {tab === 'horario' && (
        <div className="stack">
          <TimeSheet employmentId={id} canEdit={isHr} canExport={isHr} />
          <HourBankCard employmentId={id} canAdjust={isHr} />
        </div>
      )}
      {tab === 'ausencias' && <EmployeeAbsences employmentId={id} isHr={isHr} />}
      {tab === 'documentos' && <EmployeeDocuments personId={e.person_id} companyId={e.company_id} />}
      {tab === 'checklists' && <EmployeeChecklists employmentId={id} isHr={isHr} companyId={e.company_id} />}
    </>
  );
}

function Profile({ e, isHr, isAdmin, reload }: { e: any; isHr: boolean; isAdmin: boolean; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const action = useAction();
  const [msg, setMsg] = useState<string | null>(null);
  const weekly = (e.weekly_minutes / 60).toLocaleString('es-ES');

  if (editing) {
    return (
      <Card title="Editar ficha">
        <EmployeeForm
          mode="edit"
          initial={fromEmployee(e)}
          excludeEmploymentId={e.id}
          onCancel={() => setEditing(false)}
          onSubmit={async (payload) => {
            await api.patch(`/org/employees/${e.id}`, payload);
            await reload();
            setEditing(false);
          }}
        />
      </Card>
    );
  }

  const rows: [string, any][] = [
    ['DNI / NIE', e.national_id],
    ['Email', e.email],
    ['Teléfono', e.phone],
    ['Sociedad', e.company_name],
    ['Centro', e.work_center_name ? `${e.work_center_name} (${e.timezone})` : null],
    ['Departamento', e.department_name],
    ['Responsable', e.manager_name],
    ['Tipo de contrato', e.contract_type],
    ['Nº de empleado', e.employee_number],
    ['Alta', dayLabel(e.start_date) + ` ${e.start_date.slice(0, 4)}`],
    ['Jornada', `${weekly} h/semana`],
    ['Vacaciones', `${Number(e.vacation_days_per_year)} días laborables/año`],
    ['Cuenta', e.user_id ? (e.user_activated ? (e.user_active ? 'Activa' : 'Desactivada') : 'Invitación enviada, sin activar') : 'Sin cuenta'],
  ];
  return (
    <div className="grid grid-2">
      <Card
        title="Datos"
        actions={
          isHr && (
            <button className="btn btn-sm" onClick={() => setEditing(true)}>
              Editar
            </button>
          )
        }
      >
        <table>
          <tbody>
            {rows
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: '40%' }}>{k}</th>
                  <td>{v ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>
      {isHr && (
        <div className="stack">
          <Card title="Acciones">
            <ErrorBox error={action.error} />
            {msg && <Notice tone="success">{msg}</Notice>}
            <div className="row">
              {(!e.user_id || !e.user_activated) && (
                <button
                  className="btn"
                  disabled={action.busy}
                  onClick={() => action.run(async () => (await api.post(`/org/employees/${e.id}/invite`), setMsg('Invitación enviada.'), reload()))}
                >
                  {e.user_id ? 'Reenviar invitación' : 'Crear cuenta e invitar'}
                </button>
              )}
              {!e.end_date && (
                <button className="btn" onClick={() => setTransferring(true)}>
                  Traspasar a otra sociedad
                </button>
              )}
              {!e.end_date && (
                <button className="btn btn-danger" onClick={() => setTerminating(true)}>
                  Dar de baja
                </button>
              )}
            </div>
          </Card>
          {isAdmin && e.user_id && <RolesCard e={e} reload={reload} />}
        </div>
      )}
      {terminating && <TerminateModal e={e} onClose={() => setTerminating(false)} onDone={reload} />}
      {transferring && <TransferModal e={e} onClose={() => setTransferring(false)} />}
      <CustomFieldsCard key={JSON.stringify(e.custom_fields)} e={e} isHr={isHr} reload={reload} />
    </div>
  );
}

function RolesCard({ e, reload }: { e: any; reload: () => Promise<void> }) {
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const roles: any[] = e.roles ?? [];
  const [admin, setAdmin] = useState(roles.some((r) => r.role === 'admin'));
  const [hrAll, setHrAll] = useState(roles.some((r) => r.role === 'hr' && !r.company_id));
  const [hrCompanies, setHrCompanies] = useState<string[]>(roles.filter((r) => r.role === 'hr' && r.company_id).map((r) => r.company_id));
  const action = useAction();
  const [saved, setSaved] = useState(false);
  return (
    <Card title="Permisos">
      <ErrorBox error={action.error} />
      {saved && <Notice tone="success">Permisos guardados.</Notice>}
      <label className="check">
        <input type="checkbox" checked={admin} onChange={(ev) => setAdmin(ev.target.checked)} /> Administración (toda la organización)
      </label>
      <label className="check">
        <input type="checkbox" checked={hrAll} onChange={(ev) => setHrAll(ev.target.checked)} /> RR. HH. en todas las sociedades
      </label>
      {!hrAll &&
        companies.data?.map((c) => (
          <label key={c.id} className="check" style={{ marginLeft: 22 }}>
            <input
              type="checkbox"
              checked={hrCompanies.includes(c.id)}
              onChange={(ev) => setHrCompanies(ev.target.checked ? [...hrCompanies, c.id] : hrCompanies.filter((x) => x !== c.id))}
            />{' '}
            RR. HH. en {c.name}
          </label>
        ))}
      <p className="muted small">Ser responsable de equipo no necesita permiso: se deriva de quién reporta a quién.</p>
      <button
        className="btn btn-primary btn-sm"
        disabled={action.busy}
        onClick={() =>
          action.run(async () => {
            await api.put(`/org/users/${e.user_id}/roles`, { admin, hrAll, hrCompanyIds: hrCompanies });
            setSaved(true);
            await reload();
          })
        }
      >
        Guardar permisos
      </button>
    </Card>
  );
}

function TerminateModal({ e, onClose, onDone }: { e: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [endDate, setEndDate] = useState(todayIso());
  const { busy, error, run } = useAction();
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      await api.post(`/org/employees/${e.id}/terminate`, { endDate });
      await onDone();
      onClose();
    });
  };
  return (
    <Modal title={`Dar de baja a ${e.first_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <p>Su registro horario y sus documentos se conservan. Si no tiene otra relación laboral activa en el grupo, su cuenta se desactivará.</p>
        <ErrorBox error={error} />
        <Field label="Último día de trabajo">
          <input type="date" required min={e.start_date} value={endDate} onChange={(ev) => setEndDate(ev.target.value)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-danger" disabled={busy}>
            Confirmar baja
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmployeeAbsences({ employmentId, isHr }: { employmentId: string; isHr: boolean }) {
  const year = Number(todayIso().slice(0, 4));
  const balance = useLoad(() => api.get(`/absences/balance/${employmentId}?year=${year}`), [employmentId]);
  const list = useLoad(() => api.get<any[]>(`/absences/team?from=${year - 1}-01-01&to=${year + 1}-12-31`), [employmentId]);
  const [registering, setRegistering] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const mine = (list.data ?? []).filter((r) => r.employment_id === employmentId);
  return (
    <div className="stack">
      <Card
        title={`Vacaciones ${year}`}
        actions={
          isHr && (
            <div className="row">
              <button className="btn btn-sm" onClick={() => setAdjusting(true)}>
                Ajustar saldo
              </button>
              <button className="btn btn-sm btn-primary" onClick={() => setRegistering(true)}>
                Registrar ausencia
              </button>
            </div>
          )
        }
      >
        {balance.data && (
          <div className="grid grid-3">
            <div className="stat">
              <span className="stat-value">{balance.data.available}</span>
              <span className="stat-label">disponibles</span>
            </div>
            <div className="stat">
              <span className="stat-value">{balance.data.entitled + balance.data.adjustments}</span>
              <span className="stat-label">corresponden (con ajustes)</span>
            </div>
            <div className="stat">
              <span className="stat-value">{balance.data.approved}</span>
              <span className="stat-label">aprobadas</span>
            </div>
          </div>
        )}
      </Card>
      <Card title="Ausencias">
        <ErrorBox error={list.error} />
        {mine.length ? (
          <table>
            <thead>
              <tr>
                <th>Tipo</th>
                <th>Fechas</th>
                <th className="num">Días</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((r) => (
                <tr key={r.id}>
                  <td>{r.type_name}</td>
                  <td>
                    {r.start_date} → {r.end_date}
                  </td>
                  <td className="num">{Number(r.days)}</td>
                  <td>{STATUS_LABEL[r.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Sin ausencias aprobadas ni pendientes.</Empty>
        )}
      </Card>
      {registering && (
        <RequestModal
          title="Registrar ausencia (queda aprobada)"
          employmentId={employmentId}
          onClose={() => setRegistering(false)}
          onDone={() => void Promise.all([list.reload(), balance.reload()])}
        />
      )}
      {adjusting && <AdjustModal employmentId={employmentId} year={year} onClose={() => setAdjusting(false)} onDone={balance.reload} />}
    </div>
  );
}

function AdjustModal({ employmentId, year, onClose, onDone }: { employmentId: string; year: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [days, setDays] = useState(1);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Ajustar saldo de vacaciones" onClose={onClose}>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void run(async () => {
            await api.post('/absences/adjustments', { employmentId, year, days, reason });
            await onDone();
            onClose();
          });
        }}
      >
        <ErrorBox error={error} />
        <Field label="Días (negativo para restar)">
          <input type="number" step={0.5} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </Field>
        <Field label="Motivo">
          <input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Días pendientes del año anterior" />
        </Field>
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

function EmployeeDocuments({ personId, companyId }: { personId: string; companyId: string }) {
  const docs = useLoad(() => api.get<any[]>(`/documents/person/${personId}`), [personId]);
  const [uploading, setUploading] = useState(false);
  const action = useAction();
  return (
    <Card
      title="Documentos"
      actions={
        <button className="btn btn-sm btn-primary" onClick={() => setUploading(true)}>
          Subir documento
        </button>
      }
    >
      <ErrorBox error={docs.error || action.error} />
      {docs.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Documento</th>
              <th>Tipo</th>
              <th>Publicado</th>
              <th>Leído</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.data.map((d) => (
              <tr key={d.id}>
                <td>{d.title}</td>
                <td>{CATEGORY_LABEL[d.category]}</td>
                <td>{dateTime(d.published_at)}</td>
                <td>{d.first_read_at ? dateTime(d.first_read_at) : <Badge tone="warning">No</Badge>}</td>
                <td className="num">
                  <button className="btn btn-sm" onClick={() => action.run(() => download(`/documents/${d.id}/download`))}>
                    Descargar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Sin documentos.</Empty>
      )}
      {uploading && <UploadDocModal personId={personId} companyId={companyId} onClose={() => setUploading(false)} onDone={docs.reload} />}
    </Card>
  );
}

function UploadDocModal({ personId, companyId, onClose, onDone }: { personId: string; companyId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('contract');
  const [file, setFile] = useState<File | null>(null);
  const { busy, error, run } = useAction();
  return (
    <Modal title="Subir documento" onClose={onClose}>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!file) return;
          void run(async () => {
            const form = new FormData();
            form.set('personId', personId);
            form.set('companyId', companyId);
            form.set('category', category);
            form.set('title', title);
            form.set('file', file);
            await api.upload('/documents', form);
            await onDone();
            onClose();
          });
        }}
      >
        <ErrorBox error={error} />
        <Field label="Título">
          <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Contrato de trabajo" />
        </Field>
        <Field label="Tipo">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fichero">
          <input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy}>
            Subir
          </button>
        </div>
      </form>
    </Modal>
  );
}
