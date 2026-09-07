// input:  JUnit, action ledger and generation guards
// output: Persistence and connection race regression tests
// pos:    Pure notification state lifecycle tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.junit.Assert.*
import org.junit.Test

class ActionLedgerTest {
    @Test fun coldTapSurvivesRecreationUntilExplicitAck() {
        val first = ActionLedger()
        val target = Action("scope", "session", "session", "project")
        first.issued[target.actionId] = Issued(target, "reply", false)
        val restored = ActionLedger(first.json())
        assertEquals(target, restored.capture(target.actionId, "scope"))
        val pending = ActionLedger(restored.json())
        assertEquals(target, pending.pending[target.actionId])
        assertNull(pending.capture(target.actionId, "scope"))
        pending.ack(target.actionId)
        assertTrue(ActionLedger(pending.json()).pending.isEmpty())
    }

    @Test fun forgedAndOldConnectionTargetsAreRejected() {
        val ledger = ActionLedger()
        val target = Action("old", "approvals", approvalId = "approval")
        ledger.issued[target.actionId] = Issued(target, "alert", false)
        assertNull(ledger.capture("unissued", "old"))
        assertNull(ledger.capture(target.actionId, "new"))
        ledger.clear()
        assertNull(ledger.capture(target.actionId, "old"))
    }

    @Test fun summaryRemainsTappableAfterAcknowledgment() {
        val ledger = ActionLedger()
        val target = Action("scope", "sessions")
        ledger.issued[target.actionId] = Issued(target, "summary", true)
        val first = ledger.capture(target.actionId, "scope")!!
        ledger.ack(first.actionId)
        val second = ledger.capture(target.actionId, "scope")!!
        assertNotEquals(first.actionId, second.actionId)
        assertTrue(ledger.issued.containsKey(target.actionId))
    }

    @Test fun dismissedAlertDedupeSurvivesRestartAndResolution() {
        val ledger = ActionLedger()
        ledger.seen["key"] = SeenAlert("session:one", "route")
        val restored = ActionLedger(ledger.json())
        assertTrue(restored.seen.containsKey("key"))
        restored.seen.remove("key")
        assertTrue(ActionLedger(restored.json()).seen.isEmpty())
    }

    @Test fun disconnectInvalidatesCallbacksEvenOnSameScopeReconnect() {
        val generation = Generation()
        val old = generation.current()
        generation.next()
        generation.next()
        assertFalse(generation.accepts(old))
        assertTrue(generation.accepts(generation.current()))
    }
}
