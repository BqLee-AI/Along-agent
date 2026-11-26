package along_host

import stdx.encoding.json.*

// The host chooses the next action. SQL, frozen arguments and tool authorization
// stay in the private capability process.
func advanceBusinessRun(
    facts: JsonObject,
    invoke: (String) -> JsonObject,
    publish: (String, JsonObject) -> Unit
): Unit {
    let reminder = facts.get("wantsReminder").getOrThrow().asBool().getValue()
    let cancellation = facts.get("wantsCancel").getOrThrow().asBool().getValue()
    if (facts.get("restatement").getOrThrow().asBool().getValue()) {
        clarifyBusiness(publish, "请完整重述这条提醒的具体日期、时间、时区和事项；不能确定它与原请求的关系。")
        return
    }
    if (reminder && cancellation) {
        clarifyBusiness(publish, "一次只说一件事：请先告诉我是新建提醒，还是取消某条提醒。")
        return
    }
    if (cancellation && businessNull(facts.get("cancellationTarget").getOrThrow())) {
        clarifyBusiness(publish, "请给要取消的任务 id（可在任务列表看到），我才能生成取消确认。")
        return
    }
    let tool = if (cancellation) { "request_cancel_task" } else if (reminder) { "propose_task" } else { "list_tasks" }
    let outcome = invoke(tool)
    let status = jsonText(outcome, "status")
    if (status == "failed" || status == "unknown") {
        let error = outcome.get("error").getOrThrow().asObject()
        error.put("http_status", JsonInt(if (status == "unknown") { 409 } else { 500 }))
        publish("thread.failed", businessPayload([("error", error)]))
        return
    }
    if (status == "denied" && (reminder || cancellation)) {
        clarifyBusiness(publish, if (cancellation) {
            "没有权限取消该任务；请确认任务 id。"
        } else {
            "这条提醒没能处理；请重述日期、时间和时区。"
        })
        return
    }
    let value = outcome.get("result").getOrDefault({ => JsonNull() })
    let result = if (businessNull(value)) { JsonObject() } else { value.asObject() }
    let kind = result.get("kind").getOrDefault({ => JsonString("") }).asString().getValue()
    if (kind == "approval" && (reminder || cancellation)) {
        let approval = result.get("approval").getOrThrow().asObject()
        let id = approval.get("approvalId").getOrThrow()
        let card = result.get("card_id").getOrThrow()
        publish("message.delta", businessPayload([("delta", result.get("echo_text").getOrThrow())]))
        publish("card.proposed", businessPayload([
            ("card_id", card), ("schema_version", JsonString("v1")),
            ("wall_time", approval.get("wallTime").getOrThrow()),
            ("timezone_id", approval.get("timezoneId").getOrThrow()),
            ("original_text", result.get("original_text").getOrThrow())
        ]))
        publish("approval_required", businessPayload([
            ("approval_id", id), ("card_id", card),
            ("presentation_hash", approval.get("presentationHash").getOrThrow())
        ]))
        publish("thread.completed", businessPayload([("approval_id", id)]))
    } else if (reminder && kind == "time_error") {
        publish("thread.failed", businessPayload([("error", result.get("error").getOrThrow())]))
    } else if (reminder || cancellation) {
        clarifyBusiness(publish, if (kind == "clarify") { jsonText(result, "text") } else { "" })
    } else if (kind == "list_tasks") {
        let tasks = result.get("tasks").getOrThrow().asArray()
        if (tasks.size() == 0) {
            clarifyBusiness(publish, "现在没有进行中的提醒。")
            return
        }
        let summary = StringBuilder()
        summary.append("你有 ${tasks.size()} 条进行中的提醒：")
        for (task in tasks.getItems()) {
            let item = task.asObject()
            let note = jsonText(item, "note_preview")
            let preview = if (note.isEmpty()) { "(无备注)" } else { note }
            let fireAt = jsonText(item, "fire_at_local_text")
            let zone = jsonText(item, "timezone_id")
            let state = jsonText(item, "state")
            summary.append("\n- ${preview}：${fireAt}（${zone}，${state}）")
        }
        if (result.get("has_more").getOrThrow().asBool().getValue()) {
            summary.append("\n还有更多，请在任务列表查看。")
        }
        clarifyBusiness(publish, summary.toString())
    } else {
        clarifyBusiness(publish, "请给明确的日期、时间和时区，例如：明天 9:20 提醒我喝水。")
    }
}

func clarifyBusiness(publish: (String, JsonObject) -> Unit, text: String): Unit {
    publish("message.delta", businessPayload([("delta", JsonString(text))]))
    publish("thread.completed", businessPayload([("approval_id", JsonNull())]))
}

func businessPayload(pairs: Array<(String, JsonValue)>): JsonObject {
    let object = JsonObject()
    for ((name, value) in pairs) { object.put(name, value) }
    return object
}

func jsonText(object: JsonObject, key: String): String {
    return object.get(key).getOrThrow().asString().getValue()
}

func businessNull(value: JsonValue): Bool {
    match (value.kind()) { case JsNull => true; case _ => false }
}
