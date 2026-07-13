import { useVocab } from '@/i18n';
import { TasksPanel } from './TasksPanel';

// Tasks tab (design 4a) route page: full-width, both lifecycles. The data-driven body lives
// in TasksPanel, reused by the workbench right-panel Tasks tab (with an Active/History filter).
export function TasksPage() {
  const L = useVocab();
  return (
    <section className="flex h-full flex-col p-2g">
      <h1 className="mb-2g text-body font-medium text-state-ink">{L.tasks}</h1>
      <TasksPanel />
    </section>
  );
}
