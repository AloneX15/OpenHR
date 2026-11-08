'use client';

import { MyTasks } from '@/components/Lifecycle';
import { PageHeader } from '@/components/ui';

export default function TasksPage() {
  return (
    <>
      <PageHeader title="Tareas" subtitle="Lo que te toca de las altas, bajas y traspasos en curso." />
      <MyTasks />
    </>
  );
}
