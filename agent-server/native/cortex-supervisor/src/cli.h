// input:  argc/argv for cortex-supervisor
// output: parsed supervisor_options and help declarations
// pos:    Public argument contract for the native supervisor
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#ifndef CORTEX_SUPERVISOR_CLI_H
#define CORTEX_SUPERVISOR_CLI_H

#include <stdbool.h>
#include <stdint.h>

struct supervisor_options {
  int control_fd;
  bool has_cancel_fd;
  int cancel_fd;
  uint64_t grace_ms;
  bool has_deadline;
  uint64_t deadline_ms;
  char **command;
};

enum cli_result {
  CLI_OK = 0,
  CLI_HELP = 1,
  CLI_ERROR = 2,
};

enum cli_result parse_options(int argc, char **argv, struct supervisor_options *options);
void print_help(void);

#endif
