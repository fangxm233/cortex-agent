// input:  unique run token and temporary workspace path
// output: detached refork loop plus readiness/mutation files
// pos:    Adversarial double-fork descendant for supervisor tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t term_seen = 0;

static void remember_term(int signal_number) {
  (void)signal_number;
  term_seen = 1;
}

static void make_path(char *target, size_t size, const char *workspace, const char *name) {
  int written = snprintf(target, size, "%s/%s", workspace, name);
  if (written < 0 || (size_t)written >= size) _exit(70);
}

static void append_text(const char *path, const char *text) {
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd < 0) _exit(71);
  size_t length = strlen(text);
  if (write(fd, text, length) != (ssize_t)length) _exit(72);
  if (close(fd) != 0) _exit(73);
}

static void write_ready(const char *workspace) {
  char path[PATH_MAX];
  make_path(path, sizeof(path), workspace, "ready");
  append_text(path, "ready\n");
}

static void record_term(const char *workspace) {
  char path[PATH_MAX];
  make_path(path, sizeof(path), workspace, "term-observed");
  append_text(path, "term\n");
}

static void record_mutation(const char *workspace, const char *token) {
  char path[PATH_MAX];
  char line[256];
  make_path(path, sizeof(path), workspace, "mutations.log");
  int written = snprintf(line, sizeof(line), "%s %ld\n", token, (long)getpid());
  if (written < 0 || (size_t)written >= sizeof(line)) _exit(74);
  append_text(path, line);
}

static void reap_finished_children(void) {
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
}

static void fork_writer(const char *workspace, const char *token) {
  pid_t pid = fork();
  if (pid < 0) return;
  if (pid != 0) return;
  record_mutation(workspace, token);
  _exit(0);
}

static void run_refork_loop(const char *workspace, const char *token) {
  write_ready(workspace);
  for (;;) {
    if (term_seen) {
      record_term(workspace);
      term_seen = 0;
    }
    record_mutation(workspace, token);
    fork_writer(workspace, token);
    reap_finished_children();
    usleep(5000);
  }
}

static void install_handlers(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = remember_term;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  signal(SIGINT, SIG_IGN);
}

static void detach_twice(void) {
  pid_t first = fork();
  if (first < 0) exit(75);
  if (first > 0) exit(0);
  pid_t second = fork();
  if (second < 0) _exit(76);
  if (second > 0) _exit(0);
}

int main(int argc, char **argv) {
  if (argc != 3) return 64;
  install_handlers();
  detach_twice();
  run_refork_loop(argv[2], argv[1]);
  return 0;
}
