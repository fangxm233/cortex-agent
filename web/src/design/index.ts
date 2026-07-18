// @cortex-agent/web design system — token-driven core primitives (design §5).
// Every color/space/radius/shadow/font comes from tailwind.config.ts tokens;
// no primitive hard-codes a hex value.

export { TONES, statusTone, type Tone } from './tone';
export { StatusPill, type StatusPillProps } from './StatusPill';
export { MonoText, type MonoTextProps } from './MonoText';
export { ID, type IDProps } from './ID';
export { Card, CardHeader, CardBody, type CardProps } from './Card';
export { SectionHeader, type SectionHeaderProps } from './SectionHeader';
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export {
  Tabs,
  TabsRoot,
  TabsList,
  Tab,
  TabPanel,
  type TabItem,
  type TabsProps,
} from './Tabs';
export { Tooltip, TooltipProvider, type TooltipProps } from './Tooltip';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { DegradedState, type DegradedStateProps } from './DegradedState';
export { DEGRADED_SEVERITIES, severityTone, type DegradedSeverity } from './degraded';
export { Modal, ModalClose, type ModalProps } from './Modal';
export { Drawer, DrawerClose, type DrawerProps, type DrawerSide } from './Drawer';
export { Popover, PopoverClose, type PopoverProps } from './Popover';
export { ToastProvider, useToast, useToastOptional, type ToastInput } from './Toast';
