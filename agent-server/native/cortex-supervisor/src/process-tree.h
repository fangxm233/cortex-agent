// input:  Linux /proc, descendant root PID, POSIX signals
// output: descendant lists, signal sweeps, reap state
// pos:    Public Linux process-tree containment primitives
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#ifndef CORTEX_SUPERVISOR_PROCESS_TREE_H
#define CORTEX_SUPERVISOR_PROCESS_TREE_H

#include <stdbool.h>
#include <stddef.h>
#include <sys/types.h>

struct pid_list {
  pid_t *items;
  size_t length;
  size_t capacity;
};

void pid_list_init(struct pid_list *list);
void pid_list_destroy(struct pid_list *list);
bool pid_list_contains(const struct pid_list *list, pid_t pid);
int discover_descendants(pid_t supervisor_pid, struct pid_list *result);
int signal_processes(const struct pid_list *processes, int signal_number);
int signal_process_group(pid_t pgid, int signal_number);
int reap_children(pid_t main_pid, bool *main_known, int *main_status, bool *has_children);

#endif
