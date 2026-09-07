// input:  Device locale and authoritative running count
// output: Short private notification labels
// pos:    Native notification localization
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
package dev.cortex.notifications

internal class NotificationText(locale: String) {
    private val chinese = locale.startsWith("zh", ignoreCase = true)
    private fun label(en: String, zh: String): String = if (chinese) zh else en
    val background get() = label("Cortex background notifications", "Cortex 后台通知")
    val attention get() = label("Cortex needs your attention", "Cortex 待处理提醒")
    val replies get() = label("Cortex replies", "Cortex 回复")
    val privateContent get() = label("Open Cortex to view", "打开 Cortex 查看")

    fun summary(count: Int?): String = when (count) {
        null -> label("Connecting — status unavailable", "连接中，状态暂不可用")
        0 -> label("Background notifications connected", "后台通知已连接")
        else -> label("Running $count ${sessionNoun(count)}", "正在运行 $count 个 session")
    }

    private fun sessionNoun(count: Int): String = if (count == 1) "session" else "sessions"

    fun alert(kind: String): String = when (kind) {
        "askUser" -> label("A session is waiting for your answer", "一个会话正在等待你的回答")
        "plan" -> label("A session is waiting for plan approval", "一个会话正在等待计划审批")
        else -> label("An approval is waiting for review", "一项审批正在等待处理")
    }
}
