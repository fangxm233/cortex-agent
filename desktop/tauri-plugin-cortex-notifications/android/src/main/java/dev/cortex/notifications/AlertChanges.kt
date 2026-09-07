// input:  Persisted alert identities and optional owner snapshot
// output: New alerts and resolved notification keys
// pos:    Pure per-owner notification reconciliation
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

internal data class AlertChanges(val resolved: List<String>, val added: List<Alert>) {
    companion object {
        fun between(seen: Map<String, SeenAlert>, owner: String, snapshot: List<Alert>?): AlertChanges {
            if (snapshot == null) return AlertChanges(emptyList(), emptyList())
            val current = snapshot.distinctBy { it.key }
            val keys = current.map { it.key }.toSet()
            val resolved = seen.filter { it.value.owner == owner && it.key !in keys }.keys.toList()
            return AlertChanges(resolved, current.filter { it.key !in seen })
        }
    }
}
