// input:  JUnit, execution snapshots and session state
// output: Turn-completion decision, dedupe and retry regression tests
// pos:    Pure background completion detection tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.junit.Assert.*
import org.junit.Test

class CompletionsTest {
    private val idle = Session("one", "project", running = false, awaiting = false, background = false, name = "Atlas")

    private fun row(id: String, session: String? = "one", finished: String = "2026-01-01T00:00:01Z") =
        ExecutionRow(id, session, finished)

    private fun detail(status: String = "completed", kind: String = "local", thread: String? = null,
        session: String? = "one", project: String? = "project") =
        ExecutionDetail(status, kind, thread, session, project)

    private fun scan(rows: List<ExecutionRow>, processed: Set<String> = emptySet(),
        sessions: List<Session> = listOf(idle), baseline: Boolean = true,
        lookup: (String) -> ExecutionDetail? = { detail() }) =
        Completions.scan(rows, processed, sessions.associateBy { it.id }, baseline, lookup)

    @Test fun firstEnableOnlyRecordsHistoryAndNeverAnnouncesOldTurns() {
        val result = scan(listOf(row("a"), row("b")), baseline = false)
        assertTrue(result.announce.isEmpty())
        assertEquals(setOf("a", "b"), result.processed.toSet())
    }

    @Test fun oneFinishedDirectTurnAnnouncesItsSessionExactlyOnce() {
        val first = scan(listOf(row("a")))
        assertEquals(listOf(Completion("one", "project", "Atlas")), first.announce)
        assertEquals(listOf("a"), first.processed)
        assertTrue(scan(listOf(row("a")), processed = setOf("a")).announce.isEmpty())
    }

    @Test fun unsuccessfulOrForeignExecutionsAreDecidedWithoutAnnouncing() {
        val rejected = listOf(detail(status = "failed"), detail(status = "cancelled"), detail(status = "stale"),
            detail(status = "running"), detail(thread = "thr_1"), detail(kind = "dispatch"), detail(session = null))
        rejected.forEach { info ->
            val result = scan(listOf(row("a")), lookup = { info })
            assertTrue(info.toString(), result.announce.isEmpty())
            assertEquals(info.toString(), listOf("a"), result.processed)
        }
    }

    @Test fun busySessionsHoldTheirCompletionInsteadOfAnnouncingEarly() {
        listOf(idle.copy(running = true), idle.copy(awaiting = true), idle.copy(background = true)).forEach { busy ->
            val held = scan(listOf(row("a")), sessions = listOf(busy))
            assertTrue(busy.toString(), held.announce.isEmpty())
            assertTrue(busy.toString(), held.processed.isEmpty())
        }
        assertEquals(1, scan(listOf(row("a"))).announce.size)
    }

    @Test fun executionsOutsideTheDirectSessionListNeverAnnounce() {
        val result = scan(listOf(row("a", session = "thread-session")), lookup = { detail(session = "thread-session") })
        assertTrue(result.announce.isEmpty())
        assertEquals(listOf("a"), result.processed)
    }

    @Test fun repeatedCompletionsOfOneSessionCollapseToTheLatest() {
        val late = Session("two", "project", running = false, awaiting = false, background = false, name = "Late")
        val rows = listOf(row("b", finished = "2026-01-01T00:00:03Z"), row("a", finished = "2026-01-01T00:00:02Z"),
            row("c", session = "two", finished = "2026-01-01T00:00:04Z"))
        val result = scan(rows, sessions = listOf(idle, late),
            lookup = { id -> detail(session = if (id == "c") "two" else "one") })
        assertEquals(listOf("one", "two"), result.announce.map { it.sessionId })
        assertEquals(setOf("a", "b", "c"), result.processed.toSet())
    }

    @Test fun detailFailuresKeepTheirCheckpointForALaterRetry() {
        val result = scan(listOf(row("a"), row("b")), lookup = { if (it == "a") null else detail() })
        assertEquals(listOf("b"), result.processed)
        assertEquals(1, result.announce.size)
        assertEquals(1, scan(listOf(row("a")), processed = setOf("b")).announce.size)
    }

    @Test fun rememberedCompletionsSurviveServiceRecreationAndStayBounded() {
        val ledger = ActionLedger()
        assertFalse(ledger.completionBaseline)
        ledger.remember((1..Completions.MEMORY + 5).map { "exec-$it" })
        val restored = ActionLedger(ledger.json())
        assertTrue(restored.completionBaseline)
        assertEquals(Completions.MEMORY, restored.completions.size)
        assertFalse(restored.completions.contains("exec-1"))
        assertTrue(restored.completions.contains("exec-${Completions.MEMORY + 5}"))
    }

    @Test fun switchingServersDropsTheBaselineSoOldTurnsStaySilent() {
        val ledger = ActionLedger()
        ledger.remember(listOf("exec-1"))
        ledger.clear()
        assertFalse(ledger.completionBaseline)
        assertTrue(ledger.completions.isEmpty())
        assertTrue(ActionLedger(ledger.json()).completions.isEmpty())
    }
}
