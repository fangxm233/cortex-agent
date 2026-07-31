// input:  Linux /proc snapshots, child PIDs, POSIX signals
// output: complete descendant sets and reaped child status
// pos:    Linux process discovery and signaling implementation
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include "process-tree.h"

#include <dirent.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

struct proc_entry {
  pid_t pid;
  pid_t parent;
};

struct proc_snapshot {
  struct proc_entry *items;
  size_t length;
  size_t capacity;
};

void pid_list_init(struct pid_list *list) {
  *list = (struct pid_list){0};
}

void pid_list_destroy(struct pid_list *list) {
  free(list->items);
  *list = (struct pid_list){0};
}

bool pid_list_contains(const struct pid_list *list, pid_t pid) {
  for (size_t index = 0; index < list->length; index += 1) {
    if (list->items[index] == pid) return true;
  }
  return false;
}

static int grow_pids(struct pid_list *list) {
  size_t capacity = list->capacity == 0 ? 16 : list->capacity * 2;
  pid_t *items = realloc(list->items, capacity * sizeof(*items));
  if (items == NULL) return -1;
  list->items = items;
  list->capacity = capacity;
  return 0;
}

static int append_pid(struct pid_list *list, pid_t pid) {
  if (pid_list_contains(list, pid)) return 0;
  if (list->length == list->capacity && grow_pids(list) != 0) return -1;
  list->items[list->length] = pid;
  list->length += 1;
  return 0;
}

static int grow_snapshot(struct proc_snapshot *snapshot) {
  size_t capacity = snapshot->capacity == 0 ? 64 : snapshot->capacity * 2;
  struct proc_entry *items = realloc(snapshot->items, capacity * sizeof(*items));
  if (items == NULL) return -1;
  snapshot->items = items;
  snapshot->capacity = capacity;
  return 0;
}

static int append_entry(struct proc_snapshot *snapshot, struct proc_entry entry) {
  if (snapshot->length == snapshot->capacity && grow_snapshot(snapshot) != 0) return -1;
  snapshot->items[snapshot->length] = entry;
  snapshot->length += 1;
  return 0;
}

static bool parse_pid_name(const char *name, pid_t *pid) {
  char *end = NULL;
  errno = 0;
  long value = strtol(name, &end, 10);
  if (errno != 0 || end == name || *end != '\0' || value <= 0) return false;
  *pid = (pid_t)value;
  return true;
}

static int read_parent(pid_t pid, pid_t *parent) {
  char path[64];
  char stat_line[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(path, "r");
  if (file == NULL) return errno == ENOENT ? 1 : -1;
  char *line = fgets(stat_line, sizeof(stat_line), file);
  int saved_errno = errno;
  fclose(file);
  if (line == NULL) {
    errno = saved_errno;
    return errno == ENOENT ? 1 : -1;
  }
  char *suffix = strrchr(stat_line, ')');
  char state = '\0';
  long parsed_parent = 0;
  if (suffix == NULL || sscanf(suffix + 1, " %c %ld", &state, &parsed_parent) != 2) return -1;
  *parent = (pid_t)parsed_parent;
  return 0;
}

static int scan_proc(struct proc_snapshot *snapshot) {
  DIR *directory = opendir("/proc");
  if (directory == NULL) return -1;
  struct dirent *entry = NULL;
  int result = 0;
  while ((entry = readdir(directory)) != NULL) {
    pid_t pid = 0;
    pid_t parent = 0;
    if (!parse_pid_name(entry->d_name, &pid)) continue;
    int read_result = read_parent(pid, &parent);
    if (read_result == 1) continue;
    if (read_result != 0 || append_entry(snapshot, (struct proc_entry){ pid, parent }) != 0) {
      result = -1;
      break;
    }
  }
  closedir(directory);
  return result;
}

static bool entry_is_descendant(const struct proc_entry *entry, pid_t root, const struct pid_list *known) {
  return entry->parent == root || pid_list_contains(known, entry->parent);
}

static int build_descendant_closure(const struct proc_snapshot *snapshot, pid_t root, struct pid_list *result) {
  bool changed = true;
  while (changed) {
    changed = false;
    for (size_t index = 0; index < snapshot->length; index += 1) {
      const struct proc_entry *entry = &snapshot->items[index];
      if (!entry_is_descendant(entry, root, result)) continue;
      if (pid_list_contains(result, entry->pid)) continue;
      if (append_pid(result, entry->pid) != 0) return -1;
      changed = true;
    }
  }
  return 0;
}

static int compare_pids(const void *left, const void *right) {
  pid_t a = *(const pid_t *)left;
  pid_t b = *(const pid_t *)right;
  return (a > b) - (a < b);
}

int discover_descendants(pid_t supervisor_pid, struct pid_list *result) {
  struct proc_snapshot snapshot = {0};
  result->length = 0;
  int status = scan_proc(&snapshot);
  if (status == 0) status = build_descendant_closure(&snapshot, supervisor_pid, result);
  free(snapshot.items);
  if (status == 0) qsort(result->items, result->length, sizeof(*result->items), compare_pids);
  return status;
}

static int signal_one(pid_t pid, int signal_number) {
  if (kill(pid, signal_number) == 0) return 0;
  return errno == ESRCH ? 0 : -1;
}

int signal_processes(const struct pid_list *processes, int signal_number) {
  for (size_t index = 0; index < processes->length; index += 1) {
    if (signal_one(processes->items[index], signal_number) != 0) return -1;
  }
  return 0;
}

int signal_process_group(pid_t pgid, int signal_number) {
  if (kill(-pgid, signal_number) == 0) return 0;
  return errno == ESRCH ? 0 : -1;
}

int reap_children(pid_t main_pid, bool *main_known, int *main_status, bool *has_children) {
  for (;;) {
    int status = 0;
    pid_t pid = waitpid(-1, &status, WNOHANG);
    if (pid > 0) {
      if (pid == main_pid && !*main_known) {
        *main_known = true;
        *main_status = status;
      }
      continue;
    }
    if (pid == 0) {
      *has_children = true;
      return 0;
    }
    if (errno == EINTR) continue;
    if (errno == ECHILD) {
      *has_children = false;
      return 0;
    }
    return -1;
  }
}
