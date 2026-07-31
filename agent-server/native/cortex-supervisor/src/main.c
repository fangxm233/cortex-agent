// input:  pinned CLI arguments and Linux child-subreaper support
// output: cortex-supervisor process exit and NDJSON control stream
// pos:    Native supervisor executable entry point
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include "cli.h"
#include "protocol.h"
#include "supervisor.h"

#include <errno.h>
#include <stdbool.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>

static bool unsupported_injected(void) {
  const char *value = getenv("CORTEX_SUPERVISOR_TEST_UNSUPPORTED_PLATFORM");
  return value != NULL && strcmp(value, "1") == 0;
}

static bool unsupported_errno(int error_number) {
  return error_number == EINVAL || error_number == ENOSYS || error_number == EOPNOTSUPP;
}

static int configure_subreaper(int control_fd) {
  if (unsupported_injected()) {
    protocol_error(control_fd, "unsupported_platform");
    return 125;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) == 0) return 0;
  const char *reason = unsupported_errno(errno) ? "unsupported_platform" : "containment_failed";
  protocol_error(control_fd, reason);
  return 125;
}

int main(int argc, char **argv) {
  struct supervisor_options options;
  enum cli_result parsed = parse_options(argc, argv, &options);
  if (parsed == CLI_HELP) {
    print_help();
    return 0;
  }
  if (parsed == CLI_ERROR) return 125;
  signal(SIGPIPE, SIG_IGN);
  int platform_status = configure_subreaper(options.control_fd);
  if (platform_status != 0) return platform_status;
  return run_supervisor(&options);
}
