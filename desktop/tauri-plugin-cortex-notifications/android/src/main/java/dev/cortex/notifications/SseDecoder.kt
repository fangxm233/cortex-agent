// input:  SSE UTF-8 lines
// output: Framed SSE events
// pos:    Bounded tRPC SSE event framing
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

internal data class SseFrame(val event: String, val data: String)

internal class SseDecoder(private val emit: (SseFrame) -> Unit) {
    private var event = "message"
    private val data = StringBuilder()

    fun line(raw: String) {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            dispatch()
            return
        }
        val name = line.substringBefore(':')
        val value = line.substringAfter(':', "").removePrefix(" ")
        when (name) {
            "event" -> event = value
            "data" -> append(value)
        }
    }

    private fun append(value: String) {
        require(data.length + value.length < 1024 * 1024) { "SSE frame too large" }
        data.append(value).append('\n')
    }

    private fun dispatch() {
        if (data.isNotEmpty()) emit(SseFrame(event, data.toString().removeSuffix("\n")))
        event = "message"
        data.setLength(0)
    }
}
