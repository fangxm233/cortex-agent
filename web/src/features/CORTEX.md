Please update me when files in this folder change

One folder per product feature, owning its views, pure view models, hooks, provider, or neutral controller.
Cross-cutting concerns that desktop and mobile both consume (attachments, live stream, media preview, notifications) live here too.

| filename | role | function |
|---|---|---|
| attachments/ | subdir | Neutral attachment metadata, transport, bounded upload queue, and send gating |
| projects/ | subdir | Neutral project selection and creation infrastructure |
| workbench/ | subdir | Three-pane workbench frame, chat and panels |
| tasks/ | subdir | Lifecycle-grouped task list and detail modal |
| thread/ | subdir | Thread detail modal, pipeline, and artifact view |
| overview/ | subdir | Project dashboard of cost, schedules and runs |
| memory/ | subdir | Project memory file browser |
| skills/ | subdir | Installed-skill browser |
| execution/ | subdir | Execution detail drawer with live logs |
| approvals/ | subdir | Approval queue overlay |
| auth/ | subdir | Responsive provider login flow overlay |
| issues/ | subdir | Non-blocking issue queue overlay |
| notes/ | subdir | Private project notes on desktop surfaces |
| schedule/ | subdir | Shared create/edit controller and desktop schedule overlay |
| settings/ | subdir | Settings modal and its panels |
| machines/ | subdir | Shared polled machine roster, expanded-detail lifecycle and locale-free facts |
| command-palette/ | subdir | Global search and command overlay |
| notifications/ | subdir | In-app toasts for replies and notices |
| media/ | subdir | Image, video and document previewers |
| browser/ | subdir | Docked web preview pane and its address bar |
| live/ | subdir | The single live event stream and fan-out |
| connection/ | subdir | Connectivity status for the daemon badge |
| rate-limit/ | subdir | Provider throttle times and waiting counts |
| usage/ | subdir | Provider quota, spend, freshness and refresh state |
| hot-update/ | subdir | Staged frontend update prompt |
| app-update/ | subdir | App shell update prompt |
| kit/ | subdir | Design-system gallery page |
| base-demo/ | subdir | Visual base specimen page |
