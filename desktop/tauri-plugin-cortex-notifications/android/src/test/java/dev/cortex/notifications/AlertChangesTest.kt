// input:  JUnit and alert reconciliation state
// output: Dedupe, partial failure and resolution regression tests
// pos:    Pure owner-scoped alert transition tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.junit.Assert.*
import org.junit.Test

class AlertChangesTest {
    private val question = Alert("question", "session:one", "askUser", "one")
    private val plan = Alert("plan", "session:two", "plan", "two")
    private val seen = mapOf("question" to SeenAlert(question.owner, "route-one"),
        "plan" to SeenAlert(plan.owner, "route-two"))

    @Test fun repeatedPendingAndDismissedNotificationsAreNotReposted() {
        val changes = AlertChanges.between(seen, question.owner, listOf(question, question))
        assertTrue(changes.added.isEmpty())
        assertTrue(changes.resolved.isEmpty())
    }

    @Test fun failedOwnerPreservesAllPriorAlerts() {
        val changes = AlertChanges.between(seen, question.owner, null)
        assertTrue(changes.added.isEmpty())
        assertTrue(changes.resolved.isEmpty())
    }

    @Test fun resolutionCancelsOnlyItsOwner() {
        val changes = AlertChanges.between(seen, question.owner, emptyList())
        assertEquals(listOf(question.key), changes.resolved)
        assertTrue(changes.added.isEmpty())
    }

    @Test fun newRequestAfterResolutionIsPostedOnce() {
        val next = question.copy(key = "next-request")
        val changes = AlertChanges.between(seen, question.owner, listOf(next, next))
        assertEquals(listOf(question.key), changes.resolved)
        assertEquals(listOf(next), changes.added)
    }

    @Test fun freshOwnerBackfillsExistingPendingRequests() {
        assertEquals(listOf(question), AlertChanges.between(emptyMap(), question.owner, listOf(question)).added)
    }
}
