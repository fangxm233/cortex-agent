// input:  Completed execution rows, direct session snapshot, detail lookup
// output: Announceable turn completions and decided execution ids
// pos:    Pure turn-completion decision and dedupe
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

internal data class ExecutionRow(val id: String, val sessionId: String?, val finishedAt: String)
internal data class ExecutionDetail(
    val status: String, val kind: String, val threadId: String?,
    val sessionId: String?, val projectId: String?,
)
internal data class Completion(val sessionId: String, val projectId: String?, val name: String?)

/** Announceable completions plus the execution ids that never need another decision. */
internal data class CompletionScan(val announce: List<Completion>, val processed: List<String>)

internal object Completions {
    const val MEMORY = 300

    private data class Verdict(val decided: Boolean, val completion: Completion? = null)
    private val RETRY = Verdict(false)
    private val SILENT = Verdict(true)

    /**
     * Decides the executions this snapshot has not seen. Without a history baseline the
     * whole snapshot is recorded silently, so enabling the feature never replays old turns.
     */
    fun scan(
        rows: List<ExecutionRow>,
        processed: Set<String>,
        sessions: Map<String, Session>,
        baseline: Boolean,
        detail: (String) -> ExecutionDetail?,
    ): CompletionScan {
        val fresh = rows.filter { it.id !in processed }
        if (!baseline) return CompletionScan(emptyList(), fresh.map { it.id })
        val decided = mutableListOf<String>()
        val latest = linkedMapOf<String, Completion>()
        fresh.sortedBy { it.finishedAt }.forEach { row ->
            val verdict = verdict(detail(row.id), sessions)
            if (!verdict.decided) return@forEach
            decided.add(row.id)
            verdict.completion?.let { latest[it.sessionId] = it }
        }
        return CompletionScan(latest.values.toList(), decided)
    }

    // An undecided row keeps its checkpoint: a failed lookup retries later, and a session
    // that is still running, awaiting an answer or holding a background task is not finished
    // yet even though its foreground execution already reached a completed state.
    private fun verdict(detail: ExecutionDetail?, sessions: Map<String, Session>): Verdict {
        if (detail == null) return RETRY
        val session = finishedTurn(detail)?.let { sessions[it] } ?: return SILENT
        if (session.running || session.awaiting || session.background) return RETRY
        return Verdict(true, Completion(session.id, detail.projectId ?: session.projectId, session.name))
    }

    /** The session of a finished interactive turn — never a thread step or a dispatch. */
    private fun finishedTurn(detail: ExecutionDetail): String? = detail.sessionId
        ?.takeIf { detail.status == "completed" && detail.threadId == null && detail.kind != "dispatch" }
}
