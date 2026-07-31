// input:  control fd and supervisor lifecycle values
// output: newline-delimited JSON protocol v1 records
// pos:    Serializer for externally observed supervisor state
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#include "protocol.h"

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

struct signal_mapping {
  int number;
  const char *name;
};

static const struct signal_mapping SIGNALS[] = {
  { SIGHUP, "SIGHUP" },
  { SIGINT, "SIGINT" },
  { SIGQUIT, "SIGQUIT" },
  { SIGKILL, "SIGKILL" },
  { SIGTERM, "SIGTERM" },
  { SIGSTOP, "SIGSTOP" },
  { SIGABRT, "SIGABRT" },
  { SIGSEGV, "SIGSEGV" },
  { SIGPIPE, "SIGPIPE" },
  { SIGALRM, "SIGALRM" },
};

static int utc_timestamp(char *target, size_t size) {
  struct timespec now;
  struct tm utc;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0) return -1;
  if (gmtime_r(&now.tv_sec, &utc) == NULL) return -1;
  size_t prefix = strftime(target, size, "%Y-%m-%dT%H:%M:%S", &utc);
  if (prefix == 0 || prefix + 6 >= size) return -1;
  int written = snprintf(target + prefix, size - prefix, ".%03ldZ", now.tv_nsec / 1000000L);
  return written == 5 ? 0 : -1;
}

static int write_all(int fd, const char *data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, data + offset, length - offset);
    if (written > 0) {
      offset += (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    return -1;
  }
  return 0;
}

static int write_record(int fd, const char *record, int length, size_t capacity) {
  if (length < 0 || (size_t)length >= capacity) return -1;
  return write_all(fd, record, (size_t)length);
}

int protocol_started(int fd, pid_t pid, pid_t pgid) {
  char timestamp[32];
  char record[256];
  if (utc_timestamp(timestamp, sizeof(timestamp)) != 0) return -1;
  int length = snprintf(record, sizeof(record),
    "{\"v\":1,\"type\":\"started\",\"pid\":%ld,\"pgid\":%ld,\"ts\":\"%s\"}\n",
    (long)pid, (long)pgid, timestamp);
  return write_record(fd, record, length, sizeof(record));
}

int protocol_exited(int fd, bool has_code, int code, const char *signal_name) {
  char timestamp[32];
  char record[256];
  if (utc_timestamp(timestamp, sizeof(timestamp)) != 0) return -1;
  int length = has_code
    ? snprintf(record, sizeof(record), "{\"v\":1,\"type\":\"exited\",\"code\":%d,\"signal\":null,\"ts\":\"%s\"}\n", code, timestamp)
    : snprintf(record, sizeof(record), "{\"v\":1,\"type\":\"exited\",\"code\":null,\"signal\":\"%s\",\"ts\":\"%s\"}\n", signal_name, timestamp);
  return write_record(fd, record, length, sizeof(record));
}

int protocol_quiescent(int fd) {
  char timestamp[32];
  char record[192];
  if (utc_timestamp(timestamp, sizeof(timestamp)) != 0) return -1;
  int length = snprintf(record, sizeof(record),
    "{\"v\":1,\"type\":\"quiescent\",\"descendants\":0,\"ts\":\"%s\"}\n", timestamp);
  return write_record(fd, record, length, sizeof(record));
}

int protocol_error(int fd, const char *reason) {
  char timestamp[32];
  char record[192];
  if (utc_timestamp(timestamp, sizeof(timestamp)) != 0) return -1;
  int length = snprintf(record, sizeof(record),
    "{\"v\":1,\"type\":\"error\",\"reason\":\"%s\",\"ts\":\"%s\"}\n", reason, timestamp);
  return write_record(fd, record, length, sizeof(record));
}

const char *protocol_signal_name(int signal_number) {
  size_t count = sizeof(SIGNALS) / sizeof(SIGNALS[0]);
  for (size_t index = 0; index < count; index += 1) {
    if (SIGNALS[index].number == signal_number) return SIGNALS[index].name;
  }
  return "UNKNOWN";
}
