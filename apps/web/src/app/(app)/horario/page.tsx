'use client';

import { useState } from 'react';
import { HourBankCard } from '@/components/HourBankCard';
import { TimeSheet } from '@/components/TimeSheet';
import { Empty, PageHeader, Select } from '@/components/ui';
import { useSession } from '@/lib/session';

export default function MyTimePage() {
  const { me } = useSession();
  const [employmentId, setEmploymentId] = useState(me.employments[0]?.id);
  if (!employmentId) return <Empty>No tienes ninguna relación laboral activa.</Empty>;
  return (
    <>
      <PageHeader
        title="Mi control horario"
        subtitle="Tu registro de jornada. Puedes descargarlo cuando quieras: es un derecho que te reconoce el Estatuto de los Trabajadores."
        actions={
          me.employments.length > 1 && (
            <Select label="Sociedad" icon="organization" align="end" value={employmentId} onChange={setEmploymentId} options={me.employments.map((e) => ({ value: e.id, label: e.company_name, hint: e.job_title ?? undefined }))} />
          )
        }
      />
      <div className="stack">
        <TimeSheet employmentId={employmentId} canEdit />
        <HourBankCard employmentId={employmentId} canAdjust={false} />
      </div>
    </>
  );
}
