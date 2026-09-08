// input:  JUnit, notification protocol
// output: Parsing, identity and framing regression tests
// pos:    Pure notification protocol tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test fun directCountIsUniqueAndIncludesBackgroundHold() {
        val rows = Protocol.sessions("""[
          {"sessionId":"one","origin":"direct","running":true,"awaitingInput":false},
          {"sessionId":"one","origin":"direct","running":true,"awaitingInput":false},
          {"sessionId":"two","origin":"direct","running":true,"backgroundRunning":true,"awaitingInput":false},
          {"sessionId":"three","origin":"scheduled","running":true,"awaitingInput":false}
        ]""")
        assertEquals(2, rows.count { it.running })
    }

    @Test fun inactiveDuplicateCannotHideRunningOrAwaitingState() {
        val inactive = """{"sessionId":"one","origin":"direct","running":false,"awaitingInput":false}"""
        val active = """{"sessionId":"one","origin":"direct","running":true,"backgroundRunning":true,"awaitingInput":true}"""
        listOf("[$inactive,$active]", "[$active,$inactive]").forEach { body ->
            val rows = Protocol.sessions(body)
            assertEquals(1, rows.size)
            assertEquals(1, rows.count { it.running })
            assertTrue(rows.single().awaiting)
        }
    }

    @Test fun actualPendingApiShapesNeedOnlyRequestIdsAndDoNotExposeContent() {
        val session = Session("one", "project", true, true)
        val body = JSONObject("""{
          "askUser":{"requestId":"question-id","questions":[{"question":"Private question",
            "header":"Choice","options":[{"label":"Yes","description":"Private detail"}],"multiSelect":false}]},
          "plan":{"requestId":"plan-id","planContent":"Private plan","planFilePath":null}
        }""")
        val alerts = Protocol.interactions(session, body)
        assertEquals(listOf("askUser", "plan"), alerts.map { it.kind })
        assertTrue(alerts.all { it.sessionId == "one" && it.projectId == "project" })
        assertFalse(alerts.toString().contains("Private"))
        // A partial/malformed endpoint response must be retained as a failure,
        // not interpreted as resolution of the missing interaction kind.
        assertThrows(Exception::class.java) {
            Protocol.interactions(session, JSONObject("""{"askUser":null}"""))
        }
    }

    @Test fun bothInteractionKindsHaveDistinctStableKeys() {
        val session = Session("one", "project", true, true)
        val body = JSONObject("""{"askUser":{"requestId":"request"},"plan":{"requestId":"request"}}""")
        val alerts = Protocol.interactions(session, body)
        assertEquals(2, alerts.size)
        assertNotEquals(alerts[0].key, alerts[1].key)
        assertEquals(alerts, Protocol.interactions(session, body))
        assertTrue(Protocol.interactions(session, JSONObject("""{"askUser":null,"plan":null}""")).isEmpty())
    }

    @Test fun summariesTrackZeroRunningAndUnknownWithoutStaleNumbers() {
        val text = NotificationText("en")
        val states = listOf(0, 1, 3, 0, null).map(text::summary)
        assertEquals(listOf("Background notifications connected", "Running 1 session",
            "Running 3 sessions", "Background notifications connected", "Connecting — status unavailable"), states)
    }

    @Test fun malformedSnapshotNeverMeansZero() {
        listOf("{}", "[{\"sessionId\":\"one\"}]", "null").forEach {
            assertThrows(Exception::class.java) { Protocol.sessions(it) }
        }
    }

    @Test fun scopeUsesNormalizedServerAndTokenWithoutExposingThem() {
        val a = Connection.create("https://example.test/", "private-value", true, "en")
        val b = Connection.create("https://example.test", "private-value", true, "en")
        assertEquals(a.scope, b.scope)
        assertFalse(a.scope.contains("private-value"))
        assertFalse(a.toString().contains("private-value"))
        assertNotEquals(a.scope, Connection.create(b.serverUrl, "other", true, "en").scope)
        listOf("http://example.test", "https://name:pass@example.test", "https://example.test/?token=x").forEach {
            assertThrows(Exception::class.java) { Connection.create(it, "value", true, "en") }
        }
    }

    @Test fun disconnectPreservesEnabledPreferenceButErasesCredentials() {
        listOf(true, false).forEach { enabled ->
            val disconnected = Connection.create("https://example.test", "value", enabled, "en").disconnected()
            assertEquals(enabled, disconnected.enabled)
            assertEquals("", disconnected.scope)
            assertEquals("", disconnected.token)
            assertEquals("", disconnected.serverUrl)
            assertFalse(disconnected.ready)
        }
    }

    @Test fun sseFramesSupportCommentsCrLfAndMultilineData() {
        val frames = mutableListOf<SseFrame>()
        val decoder = SseDecoder { frames.add(it) }
        listOf(": heartbeat", "", "event: connected", "data: {}", "", "data: {", "data: \"type\":\"session.status\"}", "").forEach(decoder::line)
        assertEquals("connected", frames[0].event)
        assertEquals("session.status", JSONObject(frames[1].data).getString("type"))
    }

    @Test fun genuineTrpcHttpCaptureMatchesNativeFraming() {
        val frames = mutableListOf<SseFrame>()
        val decoder = SseDecoder { frames.add(it) }
        javaClass.getResourceAsStream("/trpc-subscribe.sse")!!.bufferedReader().useLines {
            it.forEach(decoder::line)
        }
        assertEquals(listOf("connected", "message", "message", "return"), frames.map { it.event })
        assertEquals("session.status", JSONObject(frames[1].data).getString("type"))
        assertEquals("session.interaction", JSONObject(frames[2].data).getString("type"))
        val query = javaClass.getResourceAsStream("/trpc-sessions.json")!!.bufferedReader().use { it.readText() }
        assertEquals(1, Protocol.sessions(Protocol.queryData(query).toString()).count { it.running })
    }

    @Test fun sessionRowsCarryDisplayNamesAndBackgroundHolds() {
        val rows = Protocol.sessions("""[
          {"sessionId":"one","origin":"direct","running":true,"backgroundRunning":true,
            "awaitingInput":false,"name":"Fallback","label":"Atlas"},
          {"sessionId":"two","origin":"direct","running":false,"awaitingInput":false,"name":"Fallback"}
        ]""")
        assertEquals(listOf("Atlas", "Fallback"), rows.map { it.name })
        assertEquals(listOf(true, false), rows.map { it.background })
    }

    @Test fun executionSnapshotsExposeOnlyIdentityAndOutcome() {
        val rows = Protocol.executions("""[
          {"id":"exec-1","sessionId":"one","status":"completed","finishedAt":"2026-01-01T00:00:00Z"},
          {"id":"exec-2","sessionId":null,"status":"completed","finishedAt":null}
        ]""")
        assertEquals(listOf("exec-1", "exec-2"), rows.map { it.id })
        assertEquals(listOf("one", null), rows.map { it.sessionId })
        assertEquals("", rows[1].finishedAt)
        assertThrows(Exception::class.java) { Protocol.executions("""[{"sessionId":"one"}]""") }
    }

    @Test fun executionDetailKeepsThreadOriginAndHidesAgentOutput() {
        val detail = Protocol.executionDetail(JSONObject("""{"id":"exec-1","status":"completed","kind":"local",
          "threadId":null,"sessionId":"one","projectId":"project",
          "text":{"finalOutput":"Private answer","label":"Private prompt"}}"""))
        assertEquals(ExecutionDetail("completed", "local", null, "one", "project"), detail)
        assertFalse(detail.toString().contains("Private"))
        val step = Protocol.executionDetail(JSONObject(
            """{"status":"completed","kind":"local","threadId":"thr_1","sessionId":"one","projectId":null}"""))
        assertEquals("thr_1", step.threadId)
        assertNull(step.projectId)
    }

    @Test fun trpcQueryEnvelopeMustContainResultData() {
        assertEquals("[]", Protocol.queryData("""{"result":{"data":[]}}""").toString())
        assertThrows(Exception::class.java) { Protocol.queryData("""{"error":{"message":"failure"}}""") }
    }
}
