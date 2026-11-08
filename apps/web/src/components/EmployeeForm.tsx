'use client';

import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { todayIso } from '@/lib/format';
import { ErrorBox, Field, useAction, useLoad } from './ui';

const DAYS = [
  ['1', 'L'],
  ['2', 'M'],
  ['3', 'X'],
  ['4', 'J'],
  ['5', 'V'],
  ['6', 'S'],
  ['7', 'D'],
] as const;

export interface EmployeeFormValue {
  firstName: string;
  lastName: string;
  nationalId: string;
  email: string;
  phone: string;
  companyId: string;
  workCenterId: string;
  departmentId: string;
  managerEmploymentId: string;
  employeeNumber: string;
  jobTitle: string;
  contractType: string;
  startDate: string;
  schedule: Record<string, number>; // horas por día
  vacationDaysPerYear: number;
  createAccount: boolean;
}

export function emptyEmployee(companyId = ''): EmployeeFormValue {
  return {
    firstName: '',
    lastName: '',
    nationalId: '',
    email: '',
    phone: '',
    companyId,
    workCenterId: '',
    departmentId: '',
    managerEmploymentId: '',
    employeeNumber: '',
    jobTitle: '',
    contractType: 'indefinido',
    startDate: todayIso(),
    schedule: { '1': 8, '2': 8, '3': 8, '4': 8, '5': 8, '6': 0, '7': 0 },
    vacationDaysPerYear: 22,
    createAccount: true,
  };
}

export function fromEmployee(e: any): EmployeeFormValue {
  return {
    firstName: e.first_name ?? '',
    lastName: e.last_name ?? '',
    nationalId: e.national_id ?? '',
    email: e.email ?? '',
    phone: e.phone ?? '',
    companyId: e.company_id,
    workCenterId: e.work_center_id ?? '',
    departmentId: e.department_id ?? '',
    managerEmploymentId: e.manager_employment_id ?? '',
    employeeNumber: e.employee_number ?? '',
    jobTitle: e.job_title ?? '',
    contractType: e.contract_type ?? '',
    startDate: e.start_date,
    schedule: Object.fromEntries(Object.entries(e.schedule as Record<string, number>).map(([k, v]) => [k, v / 60])),
    vacationDaysPerYear: Number(e.vacation_days_per_year),
    createAccount: false,
  };
}

/** Formulario de alta o edición de una relación laboral. */
export function EmployeeForm({
  initial,
  mode,
  onSubmit,
  onCancel,
  excludeEmploymentId,
}: {
  initial: EmployeeFormValue;
  mode: 'create' | 'edit';
  onSubmit: (payload: any) => Promise<void>;
  onCancel?: () => void;
  excludeEmploymentId?: string;
}) {
  const [f, setF] = useState(initial);
  const { busy, error, run } = useAction();
  const companies = useLoad(() => api.get<any[]>('/org/companies'));
  const companyId = f.companyId || companies.data?.[0]?.id || '';
  const centers = useLoad(() => (companyId ? api.get<any[]>(`/org/work-centers?companyId=${companyId}`) : Promise.resolve([])), [companyId]);
  const departments = useLoad(() => (companyId ? api.get<any[]>(`/org/departments?companyId=${companyId}`) : Promise.resolve([])), [companyId]);
  const managers = useLoad(() => api.get<any[]>('/org/employees'));
  const set = (k: keyof EmployeeFormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const weekly = Object.values(f.schedule).reduce((a, b) => a + Number(b || 0), 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const schedule = Object.fromEntries(Object.entries(f.schedule).map(([k, v]) => [k, Math.round(Number(v || 0) * 60)]));
      const common = {
        firstName: f.firstName,
        lastName: f.lastName,
        nationalId: f.nationalId || undefined,
        email: f.email || undefined,
        phone: f.phone || undefined,
        workCenterId: f.workCenterId || null,
        departmentId: f.departmentId || null,
        managerEmploymentId: f.managerEmploymentId || null,
        employeeNumber: f.employeeNumber || (mode === 'edit' ? null : undefined),
        jobTitle: f.jobTitle || (mode === 'edit' ? null : undefined),
        contractType: f.contractType || (mode === 'edit' ? null : undefined),
        schedule,
        weeklyMinutes: Math.round(weekly * 60),
        vacationDaysPerYear: Number(f.vacationDaysPerYear),
      };
      await onSubmit(mode === 'create' ? { ...common, companyId, startDate: f.startDate, createAccount: f.createAccount } : common);
    });
  };

  return (
    <form onSubmit={submit}>
      <ErrorBox error={error} />
      <h3>Persona</h3>
      <div className="form-grid">
        <Field label="Nombre">
          <input required value={f.firstName} onChange={set('firstName')} />
        </Field>
        <Field label="Apellidos">
          <input required value={f.lastName} onChange={set('lastName')} />
        </Field>
        <Field label="DNI / NIE" hint="Necesario para repartir nóminas.">
          <input value={f.nationalId} onChange={set('nationalId')} placeholder="12345678Z" />
        </Field>
        <Field label="Email">
          <input type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label="Teléfono">
          <input value={f.phone} onChange={set('phone')} />
        </Field>
      </div>
      <h3>Relación laboral</h3>
      <div className="form-grid">
        <Field label="Sociedad">
          <select value={companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, workCenterId: '', departmentId: '' })} disabled={mode === 'edit'}>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Centro de trabajo">
          <select value={f.workCenterId} onChange={set('workCenterId')}>
            <option value="">—</option>
            {centers.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Departamento">
          <select value={f.departmentId} onChange={set('departmentId')}>
            <option value="">—</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Responsable directo">
          <select value={f.managerEmploymentId} onChange={set('managerEmploymentId')}>
            <option value="">—</option>
            {managers.data
              ?.filter((m) => m.id !== excludeEmploymentId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.last_name}, {m.first_name} · {m.company_name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Puesto">
          <input value={f.jobTitle} onChange={set('jobTitle')} />
        </Field>
        <Field label="Tipo de contrato">
          <input value={f.contractType} onChange={set('contractType')} list="contract-types" />
          <datalist id="contract-types">
            <option value="indefinido" />
            <option value="temporal" />
            <option value="fijo-discontinuo" />
            <option value="formación" />
            <option value="prácticas" />
          </datalist>
        </Field>
        <Field label="Nº de empleado">
          <input value={f.employeeNumber} onChange={set('employeeNumber')} />
        </Field>
        {mode === 'create' && (
          <Field label="Fecha de alta">
            <input type="date" required value={f.startDate} onChange={set('startDate')} />
          </Field>
        )}
        <Field label="Vacaciones al año (días laborables)">
          <input type="number" min={0} max={60} step={0.5} value={f.vacationDaysPerYear} onChange={(e) => setF({ ...f, vacationDaysPerYear: Number(e.target.value) })} />
        </Field>
      </div>
      <Field label={`Jornada teórica (horas por día) · ${weekly.toLocaleString('es-ES')} h/semana`}>
        <div className="row" style={{ gap: 6 }}>
          {DAYS.map(([k, label]) => (
            <label key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', fontSize: '0.8rem', width: 58 }}>
              {label}
              <input
                type="number"
                min={0}
                max={24}
                step={0.25}
                value={f.schedule[k]}
                onChange={(e) => setF({ ...f, schedule: { ...f.schedule, [k]: Number(e.target.value) } })}
              />
            </label>
          ))}
        </div>
      </Field>
      {mode === 'create' && (
        <label className="check">
          <input type="checkbox" checked={f.createAccount} onChange={(e) => setF({ ...f, createAccount: e.target.checked })} />
          Crear su cuenta y enviarle la invitación por email
        </label>
      )}
      <div className="modal-actions">
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Guardando…' : mode === 'create' ? 'Dar de alta' : 'Guardar cambios'}
        </button>
      </div>
    </form>
  );
}
