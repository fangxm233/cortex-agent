// input:  HTTPS connection, OkHttp, tRPC SSE framing
// output: Authenticated snapshots and cancellable event stream
// pos:    Native transport without redirects or credential URLs
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

internal class CortexTransport(private val connection: Connection) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS).retryOnConnectionFailure(false).build()
    // Existing tRPC does not guarantee heartbeat frames. An idle stream is valid;
    // the independent 60-second query reconciler detects unreachable servers.
    private val streaming = client.newBuilder().readTimeout(0, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS).build()
    private val calls = mutableSetOf<Call>()
    private var closed = false
    @Volatile private var subscription: Call? = null

    fun query(procedure: String, input: JSONObject): Any {
        val call = tracked(client.newCall(request(procedure, input)))
        try {
            return call.execute().use {
                if (!it.isSuccessful) throw IOException("Snapshot unavailable")
                Protocol.queryData(requireNotNull(it.body).string())
            }
        } finally { synchronized(calls) { calls.remove(call) } }
    }

    fun subscribe(onFrame: (SseFrame) -> Unit) {
        val input = JSONObject().put("events", JSONArray(EVENTS))
        val request = request("subscribe", input).newBuilder().header("Accept", "text/event-stream").build()
        val call = tracked(streaming.newCall(request))
        subscription = call
        try {
            call.execute().use {
                if (!it.isSuccessful || it.body?.contentType()?.subtype != "event-stream")
                    throw IOException("Subscription unavailable")
                val source = requireNotNull(it.body).source()
                val decoder = SseDecoder(onFrame)
                while (!source.exhausted()) decoder.line(source.readUtf8LineStrict(1024L * 1024L))
            }
        } finally { synchronized(calls) { calls.remove(call) } }
    }

    fun interruptSubscription() { subscription?.cancel() }

    private fun request(procedure: String, input: JSONObject): Request {
        val url = "${connection.serverUrl}/trpc/$procedure".toHttpUrl().newBuilder()
            .addQueryParameter("input", input.toString()).build()
        return Request.Builder().url(url).header("x-cortex-token", connection.token).build()
    }

    private fun tracked(call: Call): Call = synchronized(calls) {
        check(!closed)
        calls.add(call)
        call
    }

    fun close() {
        synchronized(calls) {
            closed = true
            calls.forEach { it.cancel() }
            calls.clear()
        }
        client.connectionPool.evictAll()
        client.dispatcher.executorService.shutdown()
    }

    companion object {
        val EVENTS = listOf("session.status", "session.interaction", "session.rewound")
    }
}
