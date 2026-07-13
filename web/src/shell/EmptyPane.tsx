import { EmptyState } from '@/design';
import { useVocab } from '@/i18n';

export function EmptyPane({ title }: { title: string }) {
  const L = useVocab();
  return (
    <section className="flex h-full flex-col p-2g">
      <h1 className="mb-2g text-body font-medium text-state-ink">{title}</h1>
      <EmptyState title={L.shNothingHere} className="flex-1" />
    </section>
  );
}
