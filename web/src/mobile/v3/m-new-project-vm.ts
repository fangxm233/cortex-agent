// 1i 新建项目 — pure view-model bits for the new-project bottom sheet (scheme-mobile.dc.html 1i L509-518).
// Kept dependency-free so the presentational View can import the gate + copy shape without pulling data.

/** A project name is creatable once it has non-whitespace content (mirrors desktop new-project.canCreate). */
export function canCreate(name: string): boolean {
  return name.trim().length > 0;
}

/** Self-contained copy table for the sheet (avoids the shared vocab bottleneck). */
export interface MNewProjectCopy {
  /** Sheet title (17/700). */
  title: string;
  /** Faint `projects/` tag on the title row. */
  tag: string;
  /** Name input placeholder. */
  placeholder: string;
  /** Hint text before the `projects/<name>/` mono fragment. */
  hintA: string;
  /** Hint text between the two mono fragments. */
  hintB: string;
  /** Hint text after the `project_init` mono fragment. */
  hintC: string;
  /** Ink create button label. */
  create: string;
}
