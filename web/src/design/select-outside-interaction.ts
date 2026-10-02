interface OutsidePointerInteraction {
  detail: { originalEvent: Event };
  preventDefault(): void;
}

const selectOutsideEvents = new WeakSet<Event>();

export function markSelectOutsideInteraction(event: OutsidePointerInteraction): void {
  selectOutsideEvents.add(event.detail.originalEvent);
}

export function preventSelectOutsideInteraction(event: OutsidePointerInteraction): void {
  // Dialog may handle this pointerdown on a later click, after Select has unmounted.
  // Keep the mark for repeated handling; WeakSet does not retain the original event.
  if (selectOutsideEvents.has(event.detail.originalEvent)) event.preventDefault();
}
