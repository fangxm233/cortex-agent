// input:  cortex-supervisor argv
// output: validated supervisor_options or help/error output
// pos:    Strict parser for the pinned native supervisor CLI
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include "cli.h"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DEFAULT_GRACE_MS 1000U

struct parse_state {
  bool control_seen;
  bool cancel_seen;
  bool grace_seen;
  bool deadline_seen;
};

static int parse_u64(const char *flag, const char *value, uint64_t *result) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno == 0 && end != value && *end == '\0') {
    *result = (uint64_t)parsed;
    return 0;
  }
  fprintf(stderr, "Error: invalid %s value '%s'; expected a non-negative integer.\n", flag, value);
  return -1;
}

static int parse_fd(const char *flag, const char *value, int *result) {
  uint64_t parsed = 0;
  if (parse_u64(flag, value, &parsed) != 0) return -1;
  if (parsed <= INT_MAX) {
    *result = (int)parsed;
    return 0;
  }
  fprintf(stderr, "Error: %s value '%s' exceeds INT_MAX.\n", flag, value);
  return -1;
}

static int require_value(int argc, char **argv, int index, const char **value) {
  if (index + 1 < argc) {
    *value = argv[index + 1];
    return 0;
  }
  fprintf(stderr, "Error: %s requires a value.\n", argv[index]);
  return -1;
}

static int parse_control(const char *value, struct supervisor_options *options, struct parse_state *state) {
  if (state->control_seen) {
    fprintf(stderr, "Error: --control-fd may be specified only once.\n");
    return -1;
  }
  state->control_seen = true;
  return parse_fd("--control-fd", value, &options->control_fd);
}

static int parse_cancel(const char *value, struct supervisor_options *options, struct parse_state *state) {
  if (state->cancel_seen) {
    fprintf(stderr, "Error: --cancel-fd may be specified only once.\n");
    return -1;
  }
  state->cancel_seen = true;
  options->has_cancel_fd = true;
  return parse_fd("--cancel-fd", value, &options->cancel_fd);
}

static int parse_grace(const char *value, struct supervisor_options *options, struct parse_state *state) {
  if (state->grace_seen) {
    fprintf(stderr, "Error: --grace-ms may be specified only once.\n");
    return -1;
  }
  state->grace_seen = true;
  return parse_u64("--grace-ms", value, &options->grace_ms);
}

static int parse_deadline(const char *value, struct supervisor_options *options, struct parse_state *state) {
  if (state->deadline_seen) {
    fprintf(stderr, "Error: --deadline-ms may be specified only once.\n");
    return -1;
  }
  state->deadline_seen = true;
  options->has_deadline = true;
  return parse_u64("--deadline-ms", value, &options->deadline_ms);
}

static int parse_flag(const char *flag, const char *value, struct supervisor_options *options, struct parse_state *state) {
  if (strcmp(flag, "--control-fd") == 0) return parse_control(value, options, state);
  if (strcmp(flag, "--cancel-fd") == 0) return parse_cancel(value, options, state);
  if (strcmp(flag, "--grace-ms") == 0) return parse_grace(value, options, state);
  if (strcmp(flag, "--deadline-ms") == 0) return parse_deadline(value, options, state);
  fprintf(stderr, "Error: unknown option '%s'. Valid options: --control-fd, --cancel-fd, --grace-ms, --deadline-ms, --help.\n", flag);
  return -1;
}

void print_help(void) {
  puts("Usage: cortex-supervisor --control-fd <N> [--cancel-fd <N>] [--grace-ms <N>] [--deadline-ms <N>] -- <cmd> [args...]\n"
       "\nOptions:\n"
       "  --control-fd <N>   NDJSON output descriptor (required)\n"
       "  --cancel-fd <N>    Caller-to-supervisor cancellation descriptor (default: none)\n"
       "  --grace-ms <N>     TERM grace period in milliseconds (default: 1000)\n"
       "  --deadline-ms <N>  Absolute run duration in milliseconds (default: none)\n"
       "  -h, --help         Show this help\n"
       "\nExample:\n"
       "  cortex-supervisor --control-fd 3 --grace-ms 500 -- /bin/sh -c 'exit 0'\n"
       "\nTest injection:\n"
       "  CORTEX_SUPERVISOR_TEST_UNSUPPORTED_PLATFORM=1 exercises fail-closed platform handling.");
}

static enum cli_result validate_options(int argc, int separator, struct supervisor_options *options, const struct parse_state *state) {
  if (!state->control_seen) {
    fprintf(stderr, "Error: --control-fd is required.\n");
    return CLI_ERROR;
  }
  if (separator < 0 || separator + 1 >= argc) {
    fprintf(stderr, "Error: '--' followed by a command is required.\n");
    return CLI_ERROR;
  }
  options->command = &options->command[separator + 1];
  return CLI_OK;
}

enum cli_result parse_options(int argc, char **argv, struct supervisor_options *options) {
  *options = (struct supervisor_options){
    .control_fd = -1,
    .cancel_fd = -1,
    .grace_ms = DEFAULT_GRACE_MS,
    .command = argv,
  };
  struct parse_state state = {0};
  int separator = -1;
  if (argc == 2 && (strcmp(argv[1], "--help") == 0 || strcmp(argv[1], "-h") == 0)) return CLI_HELP;
  for (int index = 1; index < argc; index += 2) {
    if (strcmp(argv[index], "--") == 0) {
      separator = index;
      break;
    }
    const char *value = NULL;
    if (require_value(argc, argv, index, &value) != 0) return CLI_ERROR;
    if (parse_flag(argv[index], value, options, &state) != 0) return CLI_ERROR;
  }
  return validate_options(argc, separator, options, &state);
}
