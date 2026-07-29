/** Semantic icon constants — replaces Slack `:shortcode:` literals.
 *  All values are raw Unicode so they render correctly on any platform
 *  (Slack, Feishu, TUI). Slack renders Unicode emoji identically to shortcodes. */
export const Icons = {
  /** :warning: */
  warning: '⚠️',
  /** :information_source: */
  info: 'ℹ️',
  /** :white_check_mark: */
  ok: '✅',
  /** :x: */
  error: '❌',
  /** :arrows_counterclockwise: */
  refresh: '🔄',
  /** :hourglass_flowing_sand: */
  processing: '⏳',
  /** :stopwatch: */
  stopwatch: '⏱️',
  /** :repeat: */
  repeat: '🔁',
  /** :satellite: */
  satellite: '🛰️',
  /** :leftwards_arrow_with_hook: */
  reply: '↩️',
  /** :hook: */
  hook: '🪝',
  /** :speech_balloon: */
  waiting: '💬',
  /** :fast_forward: */
  superseded: '⏩',
  /** :octagonal_sign: */
  stopped: '🛑',
  /** :memo: */
  memo: '📝',
  /** :brain: */
  brain: '🧠',
  /** :file_folder: */
  folder: '📁',
  /** :desktop_computer: */
  desktop: '🖥️',
  /** :scroll: */
  scroll: '📜',
  /** :wave: */
  wave: '👋',
  /** :no_entry: / :no_entry_sign: */
  blocked: '🚫',
  /** :no_entry_sign: (alias for blocked — identical rendering) */
  noEntry: '🚫',
  /** :heavy_plus_sign: */
  add: '➕',
  /** :inbox_tray: */
  inbox: '📥',
  /** :pencil2: */
  edit: '✏️',
  /** :wrench: */
  tools: '🔧',
  /** :arrow_right: */
  arrowRight: '➡️',
  /** :arrow_left: */
  arrowLeft: '⬅️',
  /** :arrow_forward: */
  resume: '▶️',
  /** :double_vertical_bar: */
  paused: '⏸️',
  /** :clock1: */
  scheduled: '🕐',
  /** :radio_button: */
  pending: '🔘',
} as const;

export type IconName = keyof typeof Icons;
