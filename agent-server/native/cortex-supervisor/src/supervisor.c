// input:  parsed command, control fd, Linux process primitives
// output: contained process lifecycle and final exit classification
// pos:    Native child-subreaper lifecycle state machine
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include "supervisor.h"

#include "process-tree.h"
#include "protocol.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef POLLRDHUP
#define POLLRDHUP 0x2000
#endif

#define MONITOR_INTERVAL_MS 5U
#define STABILIZE_INTERVAL_MS 2U
#define STABILIZE_ROUNDS 100U
#define KILL_CONFIRM_MS 10000U

static volatile sig_atomic_t cancel_requested = 0;

enum terminal_trigger {
  TRIGGER_NATURAL,
  TRIGGER_CANCELLED,
  TRIGGER_DEADLINE,
  TRIGGER_REPORTING_FAILED,
};

struct child_state {
  pid_t main_pid;
  bool main_known;
  int main_status;
  bool has_children;
};

static void request_cancel(int signal_number) {
  (void)signal_number;
  cancel_requested = 1;
}

static uint64_t monotonic_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (uint64_t)now.tv_sec * 1000U + (uint64_t)now.tv_nsec / 1000000U;
}

static void sleep_ms(uint64_t milliseconds) {
  struct timespec duration = {
    .tv_sec = (time_t)(milliseconds / 1000U),
    .tv_nsec = (long)(milliseconds % 1000U) * 1000000L,
  };
  while (nanosleep(&duration, &duration) != 0 && errno == EINTR) {}
}

static int install_signal_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = request_cancel;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0) return -1;
  if (sigaction(SIGINT, &action, NULL) != 0) return -1;
  signal(SIGPIPE, SIG_IGN);
  return 0;
}

static int protect_runtime_fd(int fd) {
  int flags = fcntl(fd, F_GETFD);
  if (flags < 0) return -1;
  return fcntl(fd, F_SETFD, flags | FD_CLOEXEC);
}

static void report_exec_error(int fd, int error_number) {
  ssize_t ignored = write(fd, &error_number, sizeof(error_number));
  (void)ignored;
}

static int restore_child_sigpipe(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  return sigaction(SIGPIPE, &action, NULL);
}

static void exec_child(char **command, int error_fd) {
  if (setpgid(0, 0) != 0 || restore_child_sigpipe() != 0) {
    report_exec_error(error_fd, errno);
    _exit(125);
  }
  execvp(command[0], command);
  report_exec_error(error_fd, errno);
  _exit(125);
}

static int read_exec_result(int fd) {
  int child_errno = 0;
  ssize_t count = 0;
  do {
    count = read(fd, &child_errno, sizeof(child_errno));
  } while (count < 0 && errno == EINTR);
  if (count == 0) return 0;
  errno = count == (ssize_t)sizeof(child_errno) ? child_errno : EIO;
  return -1;
}

static int confirm_parent_group(pid_t child) {
  if (setpgid(child, child) == 0) return 0;
  if (errno == EACCES || errno == ESRCH) return 0;
  return -1;
}

static int spawn_child(char **command, pid_t *child) {
  int error_pipe[2];
  if (pipe2(error_pipe, O_CLOEXEC) != 0) return -1;
  pid_t pid = fork();
  if (pid == 0) {
    close(error_pipe[0]);
    exec_child(command, error_pipe[1]);
  }
  close(error_pipe[1]);
  if (pid < 0) {
    close(error_pipe[0]);
    return -1;
  }
  int result = confirm_parent_group(pid);
  if (result == 0) result = read_exec_result(error_pipe[0]);
  close(error_pipe[0]);
  if (result != 0) {
    kill(pid, SIGKILL);
    waitpid(pid, NULL, 0);
    return -1;
  }
  *child = pid;
  return 0;
}

static int refresh_child_state(struct child_state *state) {
  return reap_children(state->main_pid, &state->main_known, &state->main_status, &state->has_children);
}

static int cancel_fd_triggered(const struct supervisor_options *options, bool *triggered) {
  *triggered = false;
  if (!options->has_cancel_fd) return 0;
  struct pollfd descriptor = { .fd = options->cancel_fd, .events = POLLIN | POLLRDHUP };
  int result = poll(&descriptor, 1, 0);
  if (result < 0 && errno == EINTR) return 0;
  if (result < 0 || (descriptor.revents & POLLNVAL) != 0) return -1;
  if (result == 0) return 0;
  if ((descriptor.revents & (POLLHUP | POLLERR | POLLRDHUP)) != 0) {
    *triggered = true;
    return 0;
  }
  if ((descriptor.revents & POLLIN) == 0) return 0;
  char byte = '\0';
  ssize_t count = read(options->cancel_fd, &byte, 1);
  if (count >= 0) {
    *triggered = true;
    return 0;
  }
  return errno == EINTR ? 0 : -1;
}

static int choose_external_trigger(const struct supervisor_options *options, uint64_t started_at, enum terminal_trigger *trigger) {
  bool fd_cancelled = false;
  if (cancel_fd_triggered(options, &fd_cancelled) != 0) return -1;
  if (cancel_requested || fd_cancelled) {
    *trigger = TRIGGER_CANCELLED;
    return 1;
  }
  if (options->has_deadline && monotonic_ms() - started_at >= options->deadline_ms) {
    *trigger = TRIGGER_DEADLINE;
    return 1;
  }
  return 0;
}

static int choose_trigger(const struct supervisor_options *options, uint64_t started_at, struct child_state *state, enum terminal_trigger *trigger) {
  int external = choose_external_trigger(options, started_at, trigger);
  if (external != 0) return external;
  if (refresh_child_state(state) != 0) return -1;
  external = choose_external_trigger(options, started_at, trigger);
  if (external != 0) return external;
  if (!state->main_known) return 0;
  *trigger = TRIGGER_NATURAL;
  return 1;
}

static int wait_for_trigger(const struct supervisor_options *options, uint64_t started_at, struct child_state *state, enum terminal_trigger *trigger) {
  for (;;) {
    int result = choose_trigger(options, started_at, state, trigger);
    if (result != 0) return result < 0 ? -1 : 0;
    sleep_ms(MONITOR_INTERVAL_MS);
  }
}

static bool same_pids(const struct pid_list *left, const struct pid_list *right) {
  if (left->length != right->length) return false;
  if (left->length == 0) return true;
  return memcmp(left->items, right->items, left->length * sizeof(*left->items)) == 0;
}

static int stop_snapshot(pid_t supervisor_pid, struct pid_list *snapshot) {
  if (discover_descendants(supervisor_pid, snapshot) != 0) return -1;
  return signal_processes(snapshot, SIGSTOP);
}

static int freeze_until_stable(pid_t supervisor_pid, pid_t root_pgid, struct pid_list *stable) {
  struct pid_list next;
  pid_list_init(&next);
  stable->length = 0;
  if (signal_process_group(root_pgid, SIGSTOP) != 0) goto failure;
  for (unsigned int round = 0; round < STABILIZE_ROUNDS; round += 1) {
    if (stop_snapshot(supervisor_pid, &next) != 0) goto failure;
    if (same_pids(stable, &next)) {
      pid_list_destroy(&next);
      return 0;
    }
    struct pid_list swap = *stable;
    *stable = next;
    next = swap;
    sleep_ms(STABILIZE_INTERVAL_MS);
  }
failure:
  pid_list_destroy(&next);
  return -1;
}

static int send_term_and_continue(pid_t root_pgid, const struct pid_list *processes) {
  if (signal_process_group(root_pgid, SIGTERM) != 0) return -1;
  if (signal_processes(processes, SIGTERM) != 0) return -1;
  if (signal_process_group(root_pgid, SIGCONT) != 0) return -1;
  return signal_processes(processes, SIGCONT);
}

static int is_quiescent(pid_t supervisor_pid, struct child_state *state, bool *quiescent) {
  struct pid_list descendants;
  pid_list_init(&descendants);
  if (refresh_child_state(state) != 0) goto failure;
  if (discover_descendants(supervisor_pid, &descendants) != 0) goto failure;
  *quiescent = descendants.length == 0 && !state->has_children;
  pid_list_destroy(&descendants);
  return 0;
failure:
  pid_list_destroy(&descendants);
  return -1;
}

static int grace_sweep(pid_t supervisor_pid, pid_t root_pgid, uint64_t grace_ms, struct child_state *state) {
  uint64_t deadline = monotonic_ms() + grace_ms;
  struct pid_list descendants;
  pid_list_init(&descendants);
  while (monotonic_ms() < deadline) {
    bool quiescent = false;
    if (is_quiescent(supervisor_pid, state, &quiescent) != 0) goto failure;
    if (quiescent) break;
    if (discover_descendants(supervisor_pid, &descendants) != 0) goto failure;
    if (send_term_and_continue(root_pgid, &descendants) != 0) goto failure;
    sleep_ms(MONITOR_INTERVAL_MS);
  }
  pid_list_destroy(&descendants);
  return 0;
failure:
  pid_list_destroy(&descendants);
  return -1;
}

static int kill_snapshot(pid_t root_pgid, const struct pid_list *processes) {
  if (signal_process_group(root_pgid, SIGKILL) != 0) return -1;
  return signal_processes(processes, SIGKILL);
}

static int kill_until_quiescent(pid_t supervisor_pid, pid_t root_pgid, struct child_state *state) {
  uint64_t deadline = monotonic_ms() + KILL_CONFIRM_MS;
  struct pid_list frozen;
  pid_list_init(&frozen);
  while (monotonic_ms() < deadline) {
    if (freeze_until_stable(supervisor_pid, root_pgid, &frozen) != 0) goto failure;
    if (kill_snapshot(root_pgid, &frozen) != 0) goto failure;
    sleep_ms(STABILIZE_INTERVAL_MS);
    bool quiescent = false;
    if (is_quiescent(supervisor_pid, state, &quiescent) != 0) goto failure;
    if (quiescent) {
      pid_list_destroy(&frozen);
      return 0;
    }
  }
failure:
  pid_list_destroy(&frozen);
  return -1;
}

static int contain_tree(const struct supervisor_options *options, struct child_state *state) {
  pid_t supervisor_pid = getpid();
  struct pid_list frozen;
  pid_list_init(&frozen);
  int result = freeze_until_stable(supervisor_pid, state->main_pid, &frozen);
  if (result == 0) result = send_term_and_continue(state->main_pid, &frozen);
  if (result == 0) result = grace_sweep(supervisor_pid, state->main_pid, options->grace_ms, state);
  pid_list_destroy(&frozen);
  if (result != 0) return -1;
  bool quiescent = false;
  if (is_quiescent(supervisor_pid, state, &quiescent) != 0) return -1;
  return quiescent ? 0 : kill_until_quiescent(supervisor_pid, state->main_pid, state);
}

static int emit_child_exit(int fd, int status) {
  if (WIFEXITED(status)) return protocol_exited(fd, true, WEXITSTATUS(status), NULL);
  if (WIFSIGNALED(status)) {
    int signal_number = WTERMSIG(status);
    return protocol_exited(fd, false, 0, protocol_signal_name(signal_number));
  }
  return -1;
}

static int natural_exit_code(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

static int classified_exit(enum terminal_trigger trigger, int status) {
  if (trigger == TRIGGER_REPORTING_FAILED) return 125;
  if (trigger == TRIGGER_CANCELLED) return 130;
  if (trigger == TRIGGER_DEADLINE) return 124;
  return natural_exit_code(status);
}

static int containment_error(int control_fd) {
  protocol_error(control_fd, "containment_failed");
  return 125;
}

int run_supervisor(const struct supervisor_options *options) {
  cancel_requested = 0;
  uint64_t started_at = monotonic_ms();
  if (started_at == 0 || install_signal_handlers() != 0) return containment_error(options->control_fd);
  if (protect_runtime_fd(options->control_fd) != 0) return containment_error(options->control_fd);
  if (options->has_cancel_fd && protect_runtime_fd(options->cancel_fd) != 0) return containment_error(options->control_fd);
  struct child_state state = {0};
  if (spawn_child(options->command, &state.main_pid) != 0) return containment_error(options->control_fd);
  bool reporting_failed = protocol_started(options->control_fd, state.main_pid, state.main_pid) != 0;
  enum terminal_trigger trigger = reporting_failed ? TRIGGER_REPORTING_FAILED : TRIGGER_NATURAL;
  if (!reporting_failed && wait_for_trigger(options, started_at, &state, &trigger) != 0) {
    return containment_error(options->control_fd);
  }
  if (contain_tree(options, &state) != 0) return containment_error(options->control_fd);
  if (!state.main_known) return containment_error(options->control_fd);
  if (reporting_failed) return 125;
  if (emit_child_exit(options->control_fd, state.main_status) != 0) return 125;
  if (protocol_quiescent(options->control_fd) != 0) return 125;
  return classified_exit(trigger, state.main_status);
}
