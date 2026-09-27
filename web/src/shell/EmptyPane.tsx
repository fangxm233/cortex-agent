import { EmptyState } from '@/design';
import { useVocab, type Vocab } from '@/i18n';

export function EmptyPane({ titleKey }: { titleKey: keyof Vocab }) {
  const L = useVocab();
  return (
    <section className="flex h-full flex-col p-2g">
      <h1 className="mb-2g text-body font-medium text-state-ink">{L[titleKey]}</h1>
      <EmptyState title={L.shNothingHere} className="flex-1" />
    </section>
  );
}
