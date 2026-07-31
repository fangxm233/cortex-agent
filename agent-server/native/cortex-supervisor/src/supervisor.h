// input:  parsed options and Linux process primitives
// output: supervised command exit classification
// pos:    Public entry to the containment lifecycle state machine
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

#ifndef CORTEX_SUPERVISOR_RUNTIME_H
#define CORTEX_SUPERVISOR_RUNTIME_H

#include "cli.h"

int run_supervisor(const struct supervisor_options *options);

#endif
