'use client';

import { useState } from 'react';
import { TimeSheet } from '@/components/TimeSheet';
import { Empty, PageHeader } from '@/components/ui';
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
            <select value={employmentId} onChange={(e) => setEmploymentId(e.target.value)}>
              {me.employments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.company_name}
                </option>
              ))}
            </select>
          )
        }
      />
      <TimeSheet employmentId={employmentId} canEdit />
    </>
  );
}
