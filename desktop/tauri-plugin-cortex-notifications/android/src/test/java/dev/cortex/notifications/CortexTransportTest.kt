// input:  Native OkHttp transport and real tRPC adapter captures
// output: Cross-layer HTTP request/framing and cancellation regression tests
// pos:    JVM loopback integration tests, without an Android emulator
package dev.cortex.notifications

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CortexTransportTest {
    private class Request(val socket: Socket, val target: String, val headers: Map<String, String>) {
        fun respond(body: String, type: String = "application/json") {
            val bytes = body.toByteArray()
            val output = socket.getOutputStream()
            output.write(("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray())
            output.write(bytes)
            output.flush()
        }
    }

    // ServerSocket is available on both the Android compile bootclasspath and
    // the host JVM; no emulator, JDK-specific HTTP module or mock library needed.
    private class Server : AutoCloseable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val workers = Executors.newCachedThreadPool()
        val handlers = ConcurrentHashMap<String, (Request) -> Unit>()
        val failures = ConcurrentLinkedQueue<Throwable>()
        val port get() = socket.localPort
        init {
            workers.execute {
                while (!socket.isClosed) {
                    val client = try { socket.accept() } catch (_: Exception) { break }
                    workers.execute {
                        client.use {
                            try {
                                it.soTimeout = 3000
                                val reader = it.getInputStream().bufferedReader()
                                val line = reader.readLine().split(" ")
                                assertEquals("GET", line[0])
                                val headers = mutableMapOf<String, String>()
                                while (true) {
                                    val header = reader.readLine() ?: break
                                    if (header.isEmpty()) break
                                    headers[header.substringBefore(':').lowercase()] = header.substringAfter(':').trim()
                                }
                                val request = Request(it, line[1], headers)
                                requireNotNull(handlers[request.target.substringBefore('?')])(request)
                            } catch (error: Throwable) { failures.add(error) }
                        }
                    }
                }
            }
        }
        override fun close() {
            socket.close()
            workers.shutdown()
            if (!workers.awaitTermination(3, TimeUnit.SECONDS)) workers.shutdownNow()
        }
    }

    private fun fixture(name: String) = javaClass.getResourceAsStream("/$name")!!
        .bufferedReader().use { it.readText() }

    private fun input(request: Request): JSONObject {
        assertEquals("test-token", request.headers["x-cortex-token"])
        assertFalse(request.target.contains("test-token"))
        return JSONObject(URLDecoder.decode(request.target.substringAfter("?input="), "UTF-8"))
    }

    private fun server(block: (Server, CortexTransport) -> Unit) {
        val server = Server()
        // Bypass Connection.create's production HTTPS requirement only for this
        // loopback fixture. The actual request builder and response decoder run.
        val transport = CortexTransport(Connection("http://127.0.0.1:${server.port}", "test-token", true, "en"))
        try { block(server, transport) } finally { transport.close(); server.close() }
        assertTrue(server.failures.toString(), server.failures.isEmpty())
    }

    @Test fun queryAndSubscriptionUseServerRoutesInputsAndUntransformedEnvelopes() = server { server, transport ->
        server.handlers["/trpc/sessions.list"] = { request ->
            assertEquals("direct", input(request).getString("origin"))
            request.respond(fixture("trpc-sessions.json"))
        }
        server.handlers["/trpc/subscribe"] = { request ->
            assertEquals("text/event-stream", request.headers["accept"])
            assertEquals(JSONArray(CortexTransport.EVENTS).toString(), input(request).getJSONArray("events").toString())
            request.respond(fixture("trpc-subscribe.sse"), "text/event-stream")
        }
        val rows = transport.query("sessions.list", JSONObject().put("origin", "direct"))
        assertEquals(1, Protocol.sessions(rows.toString()).count { it.running })
        val frames = mutableListOf<SseFrame>()
        transport.subscribe { frames.add(it) }
        assertEquals(listOf("connected", "message", "message", "return"), frames.map { it.event })
        assertEquals("session.interaction", JSONObject(frames[2].data).getString("type"))
    }

    @Test fun snapshotsDoNotInterruptIdleStreamAndCloseCancelsIt() = server { server, transport ->
        val connected = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.handlers["/trpc/subscribe"] = { request ->
            val output = request.socket.getOutputStream()
            output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: connected\ndata: {}\n\n".toByteArray())
            output.flush()
            release.await(5, TimeUnit.SECONDS)
        }
        server.handlers["/trpc/sessions.list"] = { it.respond(fixture("trpc-sessions.json")) }
        val worker = Executors.newSingleThreadExecutor()
        try {
            val stream = worker.submit {
                runCatching { transport.subscribe { if (it.event == "connected") connected.countDown() } }
            }
            assertTrue(connected.await(3, TimeUnit.SECONDS))
            repeat(3) { transport.query("sessions.list", JSONObject().put("origin", "direct")) }
            assertFalse(stream.isDone)
            transport.close()
            stream.get(3, TimeUnit.SECONDS)
        } finally { release.countDown(); worker.shutdownNow() }
    }

    @Test fun redirectsCannotForwardCredentialsAndErrorsAreNotEmptySnapshots() = server { server, transport ->
        val redirected = java.util.concurrent.atomic.AtomicInteger()
        server.handlers["/other"] = { redirected.incrementAndGet(); it.respond("{\"result\":{\"data\":[]}}") }
        server.handlers["/trpc/sessions.list"] = {
            it.socket.getOutputStream().write("HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
        }
        assertThrows(Exception::class.java) { transport.query("sessions.list", JSONObject()) }
        assertEquals(0, redirected.get())
        server.handlers["/trpc/approvals.list"] = { it.respond("{\"error\":{\"message\":\"unavailable\"}}") }
        assertThrows(Exception::class.java) { transport.query("approvals.list", JSONObject()) }
    }
}
