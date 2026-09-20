import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

// ONE store for "which global overlays are open, and with what payload".
//
// Before this, every global modal shipped its own provider: a createContext, a wrapper component
// holding `useState(false)` plus whatever the trigger had to hand over, and a mount of the modal
// after `{children}`. Nine of them nested inside AppShell, which is nine context layers and nine
// places to remember when a new overlay is added. They all had the same shape — open(payload) /
// close() / "is it open" — so they are all one store keyed by a string.
//
// Design:
//   · state is a Map<kind, {payload}> in a plain external store, read through useSyncExternalStore.
//     A slot object is replaced ONLY when its own kind changes, so a subscriber to kind A keeps an
//     identical snapshot when kind B opens and React bails out of its re-render. Per-kind contexts
//     created by the factory would give the same isolation, but the provider would then have to
//     nest one Provider per declared kind — a list nothing can assemble without a registry of
//     contexts, i.e. this store with extra steps.
//   · the kind is declared by the feature that owns the modal, via `defineModal`, so the typed key
//     lives beside the modal instead of in a central union that every feature has to edit.
//   · no exclusivity: opening one kind never closes another. That mirrors the providers this
//     replaces — none of them knew about each other — and each modal is its own Radix dialog with
//     its own portal and z-index, so stacking does not depend on mount order either.
//
// Trigger call sites use `useModalActions()` (stable callbacks, NO subscription): a button that
// opens Settings must not re-render when Settings opens. The single host that renders the modal
// uses `useModal()` and is the only subscriber.

type Slot = { payload: unknown };
type Listener = () => void;

export interface ModalRegistry {
  /** The open slot for `kind`, or undefined when it is closed. Identity is stable per kind. */
  slot: (kind: string) => Slot | undefined;
  open: (kind: string, payload: unknown) => void;
  close: (kind: string) => void;
  subscribe: (listener: Listener) => () => void;
  /** A host for `kind` is mounted; returns the detach. Only used to catch an `open()` nobody renders. */
  attachHost: (kind: string) => () => void;
}

// A registry with no host for a kind swallows `open()` silently — on a chrome that simply does
// not mount that overlay (mobile today) that is the intended no-op, but in the desktop shell it
// means a modal was declared and never added to ShellModalHost. Say so in development; the test
// runner mounts triggers without hosts on purpose, so stay quiet there.
const WARN_ORPHAN_OPEN = import.meta.env.DEV && import.meta.env.MODE !== 'test';

export function createModalRegistry(): ModalRegistry {
  const slots = new Map<string, Slot>();
  const listeners = new Set<Listener>();
  const hosts = new Map<string, number>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    slot: (kind) => slots.get(kind),
    open: (kind, payload) => {
      if (WARN_ORPHAN_OPEN && !hosts.get(kind)) {
        console.warn(`modal "${kind}" opened but nothing renders it — is its host in ShellModalHost?`);
      }
      const previous = slots.get(kind);
      // Re-opening with the same payload is what `setOpen(true)` while open used to be: a no-op.
      if (previous && Object.is(previous.payload, payload)) return;
      slots.set(kind, { payload });
      emit();
    },
    close: (kind) => {
      if (!slots.delete(kind)) return;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachHost: (kind) => {
      hosts.set(kind, (hosts.get(kind) ?? 0) + 1);
      return () => { hosts.set(kind, (hosts.get(kind) ?? 1) - 1); };
    },
  };
}

// Nothing mounted (a component rendered outside a shell, most isolated unit tests): every kind
// reads as closed and open/close do nothing. Modals that used to default to a no-op context keep
// behaving that way; the ones that used to throw still throw — see `defineModal`.
const INERT: ModalRegistry = {
  slot: () => undefined,
  open: () => {},
  close: () => {},
  subscribe: () => () => {},
  attachHost: () => () => {},
};

const ModalRegistryContext = createContext<ModalRegistry | null>(null);

export function ModalRegistryProvider({ children }: { children: ReactNode }): JSX.Element {
  const [registry] = useState(createModalRegistry);
  return <ModalRegistryContext.Provider value={registry}>{children}</ModalRegistryContext.Provider>;
}

export function useModalRegistry(): ModalRegistry {
  const registry = useContext(ModalRegistryContext);
  if (!registry) throw new Error('useModalRegistry must be used within a ModalRegistryProvider');
  return registry;
}

/** `open()` for a modal that carries nothing, `open(payload)` for one that does. */
export type ModalOpen<TPayload> = [TPayload] extends [void]
  ? () => void
  : (payload: TPayload) => void;

export interface ModalActions<TPayload> {
  open: ModalOpen<TPayload>;
  close: () => void;
}

export interface ModalHandle<TPayload> extends ModalActions<TPayload> {
  isOpen: boolean;
  payload: TPayload | undefined;
}

export interface ModalKey<TPayload> {
  kind: string;
  /** Subscribes to this kind. For the ONE host that renders the modal. */
  useModal: () => ModalHandle<TPayload>;
  /** Stable open/close with no subscription. For triggers — a menu item, a card, a banner. */
  useModalActions: () => ModalActions<TPayload>;
}

interface DefineModalOptions {
  /** false → a caller outside a ModalRegistryProvider gets inert no-ops instead of a throw. */
  requireProvider?: boolean;
}

/**
 * Declare a typed modal key. `TPayload` is whatever the trigger hands the modal; use `void` for
 * modals that carry nothing.
 *
 * The feature keeps its own hook name and return shape on top of this — `useTaskModal()`,
 * `useSettings()` — so call sites never see the registry.
 */
export function defineModal<TPayload = void>(
  kind: string,
  options: DefineModalOptions = {},
): ModalKey<TPayload> {
  const required = options.requireProvider ?? true;

  function useRegistry(): ModalRegistry {
    const registry = useContext(ModalRegistryContext);
    if (!registry && required) {
      throw new Error(`modal "${kind}" needs a <ModalRegistryProvider> above it`);
    }
    return registry ?? INERT;
  }

  function useActions(registry: ModalRegistry): ModalActions<TPayload> {
    return useMemo(() => ({
      open: ((payload: TPayload) => registry.open(kind, payload)) as ModalOpen<TPayload>,
      close: () => registry.close(kind),
    }), [registry]);
  }

  return {
    kind,
    useModal(): ModalHandle<TPayload> {
      const registry = useRegistry();
      const actions = useActions(registry);
      useEffect(() => registry.attachHost(kind), [registry]);
      const slot = useSyncExternalStore(
        registry.subscribe,
        useCallback(() => registry.slot(kind), [registry]),
      );
      return { isOpen: !!slot, payload: slot?.payload as TPayload | undefined, ...actions };
    },
    useModalActions(): ModalActions<TPayload> {
      return useActions(useRegistry());
    },
  };
}
