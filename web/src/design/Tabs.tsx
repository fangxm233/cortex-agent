// input:  Radix Tabs, React, shared focus-visible styles
// output: Tabs, TabsRoot, TabsList, Tab, TabPanel, tab types
// pos:    Keyboard tabs with a tinted active state
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

// Token-styled wrapper over Radix Tabs (approved primitive layer, design §1):
// keyboard/a11y from Radix, colors from tokens. Exposes both a data-driven form
// (`Tabs`) and the styled parts (`TabsRoot`/`TabsList`/`Tab`/`TabPanel`).

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultValue?: string;
  className?: string;
}

const LIST_CLASS = 'flex items-center gap-0.5g border-b border-card';

const TRIGGER_CLASS =
  'rounded-t-[var(--r-control)] px-2g py-1g text-ui font-medium text-proto-muted transition-colors ' +
  'hover:text-state-ink ' +
  'data-[state=active]:bg-pill-running-bg data-[state=active]:text-pill-running-fg';

export function Tabs({ items, defaultValue, className }: TabsProps) {
  return (
    <RadixTabs.Root defaultValue={defaultValue ?? items[0]?.value} className={className}>
      <RadixTabs.List className={LIST_CLASS}>
        {items.map((item) => (
          <RadixTabs.Trigger key={item.value} value={item.value} className={TRIGGER_CLASS}>
            {item.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="pt-2g">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}

export const TabsRoot = RadixTabs.Root;
export const TabsList = (props: RadixTabs.TabsListProps) => (
  <RadixTabs.List {...props} className={[LIST_CLASS, props.className].filter(Boolean).join(' ')} />
);
export const Tab = (props: RadixTabs.TabsTriggerProps) => (
  <RadixTabs.Trigger
    {...props}
    className={[TRIGGER_CLASS, props.className].filter(Boolean).join(' ')}
  />
);
export const TabPanel = (props: RadixTabs.TabsContentProps) => (
  <RadixTabs.Content {...props} className={['pt-2g', props.className].filter(Boolean).join(' ')} />
);
