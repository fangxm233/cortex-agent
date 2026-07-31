// input:  control fd, process status, containment reason
// output: pinned v1 NDJSON records
// pos:    Public writer interface for the supervisor protocol
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#ifndef CORTEX_SUPERVISOR_PROTOCOL_H
#define CORTEX_SUPERVISOR_PROTOCOL_H

#include <stdbool.h>
#include <sys/types.h>

int protocol_started(int fd, pid_t pid, pid_t pgid);
int protocol_exited(int fd, bool has_code, int code, const char *signal_name);
int protocol_quiescent(int fd);
int protocol_error(int fd, const char *reason);
const char *protocol_signal_name(int signal_number);

#endif
