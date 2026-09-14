/**
 * A row that mixes a select, a text input and a button only reads as one control strip when the
 * three share a height — padding alone does not get there, because an input, a button and the
 * Select trigger resolve their line boxes differently. Two sizes cover the desktop surfaces:
 * `sm` for the inline settings rows, `md` for the field cells of a modal form.
 */
export const CONTROL_HEIGHT = { sm: 24, md: 32 } as const;
