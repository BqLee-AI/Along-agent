package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*

import std.collection.*
import stdx.encoding.json.*

extend Harness {
    protected func loop(): Unit {
        if (pipe.compactControl) {
            require(isNull(waiting) && isNull(pendingModel) && contextState.units.size == 0 && toolRefs.size() == 0)
            if (restoredPause) { finish("done", ""); return }
            if (pausePoint()) { return }
            finish("failed", "COMPACT_PAUSE_UNAVAILABLE")
            return
        }
        if (pipe.protocol != "harness/v6" && pausePoint()) { return }
        if (routeFirstStep()) { return }
        if (!restoredPause && budgetState.iterations < budgetState.maxIterations && budgetState.knownTokens < budgetState.maxTokens) { restoreBootstrap() }
        while (true) {
            if (pausePoint()) { return }
            var m = JsonObject()
            if (isNull(pendingModel)) {
            if (budgetState.iterations >= budgetState.maxIterations || budgetState.knownTokens >= budgetState.maxTokens) { finish("failed", "BUDGET_EXCEEDED"); return }
            let output = measuredOutput(true)
            // A v8 measurement can atomically register an automatic compact.
            // Recheck before spending a model permit or incrementing usage.
            if (pipe.protocol == "harness/v8" && pausePointWithMarker(true)) { return }
            var step = pipe.request("model", candidate(output)).asObject()
            if (str(field(step, "type"), 32) == "pause_requested") {
                require(pipe.protocol != "harness/v6")
                keys(step, ["type"])
                continue
            }
            let modelRef = "r${pipe.serial}"
            budgetState.iterations++
            let previouslyKnown = budgetState.tokensKnown
            // Every returned step proves a provider request occurred. A broken
            // stream is unknown usage until a truthful terminal step arrives.
            budgetState.tokensKnown = false
            for (unit in contextState.units) { unit.seen = true }
            let streamed = ArrayList<UInt8>()
            while (str(field(step, "type"), 16) == "delta") {
                keys(step, ["type", "delta"])
                let delta = str(field(step, "delta"), 4000)
                require(delta.size > 0 && streamed.size <= FRAME_LIMIT - delta.size)
                for (b in delta.toArray()) { streamed.add(b) }
                // Persist each accepted delta before pulling again (#70).
                pipe.ack("answer", obj([("delta", text(delta))]), "accepted")
                step = pipe.request("model_next", obj([("model_ref", text(modelRef))])).asObject()
            }
            if (str(field(step, "type"), 16) == "failed") {
                keys(step, ["type", "error", "usage"])
                let code = errorCheck(field(step, "error"))
                budgetState.acceptUsage(field(step, "usage"), previouslyKnown)
                finish("failed", code)
                return
            }
            keys(step, ["type", "reply"])
            require(str(field(step, "type"), 16) == "complete")
            let response = field(step, "reply").asObject()
            keys(response, ["message", "usage"])
            budgetState.acceptUsage(field(response, "usage"), previouslyKnown)
            m = field(response, "message").asObject()
            keys(m, ["content", "tool_calls"])
            let streamedContent = field(m, "content")
            if (!isNull(streamedContent)) { str(streamedContent, FRAME_LIMIT) }
            if (isNull(streamedContent)) { require(streamed.size == 0) }
            else { require(str(streamedContent, FRAME_LIMIT) == String.fromUtf8(streamed.toArray())) }
            } else {
                m = pendingModel.asObject()
            }
            let content = field(m, "content")
            let calls = field(m, "tool_calls").asArray()
            require(calls.size() <= 64)
            if (budgetState.knownTokens > budgetState.maxTokens) { finish("failed", "BUDGET_EXCEEDED"); return }
            if (calls.size() > 1) {
                message("system", "Your last response proposed multiple tool calls despite the single-call protocol. None of those proposed calls was executed. Continue with exactly one tool call per response, using actual results before choosing the next action.")
                continue
            }
            if (calls.size() == 0) {
                pendingModel = m
                if (pausePoint()) { return }
                pendingModel = JsonNull()
                require(!isNull(content))
                let answer = str(content, FRAME_LIMIT)
                require(answer.size > 0)
                if (delegated) {
                    message("assistant", answer)
                    message("system", "The previous prose has not finished this goal. Review the actual requested outcomes and accepted receipts; call finish_goal now with a truthful structured result. Do not repeat accepted effects.")
                    continue
                }
                checkpoint()
                finish("done", "")
                return
            }
            // Exhausted token budget cannot authorize another effect.
            if (budgetState.knownTokens >= budgetState.maxTokens) { finish("failed", "BUDGET_EXCEEDED"); return }
            pendingModel = m
            if (pausePoint()) { return }
            pendingModel = JsonNull()
            let call = calls.get(0).getOrThrow().asObject()
            keys(call, ["id", "type", "function"])
            ref(field(call, "id")); require(str(field(call, "type"), 16) == "function")
            let function = field(call, "function").asObject()
            keys(function, ["name", "arguments"])
            let name = ref(field(function, "name"))
            let arguments = str(field(function, "arguments"), FRAME_LIMIT)
            if (delegated && name == "finish_goal") {
                let feedback = match (goalArguments(arguments)) {
                    case Some(goal) =>
                        pipe.request("finish_goal", obj([("goal_result", goal), ("usage", budgetState.usage())])).asObject()
                    case None =>
                        obj([
                            ("accepted", JsonBool(false)), ("code", text("INVALID_GOAL_RESULT")),
                            ("message", text("Goal result was not accepted. Follow the finish_goal schema: include status, nonempty outcomes, clarification (null or a valid question), and answer. Match aggregate and outcome statuses; receipt_refs must be unique accepted successful invocation UUIDs, never denied/failed/provider IDs."))
                        ])
                }
                if (field(feedback, "accepted").asBool().getValue()) {
                    keys(feedback, ["accepted"])
                    return
                }
                keys(feedback, ["accepted", "code", "message"])
                require(ref(field(feedback, "code")) == "INVALID_GOAL_RESULT")
                str(field(feedback, "message"), 8192)
                closingGoal = true
                let historyContent: JsonValue = if (isNull(content)) { text("") } else { content }
                modelMessage(obj([("role", text("assistant")), ("content", historyContent), ("tool_calls", calls)]))
                modelMessage(obj([("role", text("tool")), ("tool_call_id", field(call, "id")), ("content", text(feedback.toString()))]))
                message("system", "Correct only the structured result using the accepted receipts; no further business actions are allowed. The original iteration/token budget still applies.")
                continue
            }
            if (hardDenied != "" || closingGoal) {
                // Rejected control arguments never reopen business execution.
                // No reservation, invocation, invented receipt, or reset budget.
                let reason = if (closingGoal) { "Goal completion is awaiting a valid structured result. The proposed business call was not executed. Call finish_goal only; preserve actual accepted receipts." }
                    else { "This Run stopped business actions after ${hardDenied}. The proposed tool call was not executed. Call finish_goal with truthful blocked/partial outcomes and preserve already accepted receipts." }
                message("system", reason)
                continue
            }
            if (!tools.contains(name)) { finish("failed", "TOOL_DENIED"); return }
            let office = isOfficeTool(name)
            let args = if (office) {
                match (officeArguments(name, arguments)) {
                    case Some(valid) => valid
                    case None =>
                        message("system", "The proposed office tool arguments were invalid and no action was taken. Use only that tool's schema and accepted source invocation IDs; retry only the intended authorized action.")
                        continue
                }
            } else { JsonValue.fromStr(arguments).asObject() }
            if (toolRefs.size() >= 64) { finish("failed", "HARNESS_CONTEXT_LIMIT"); return }
            require(nextCall < SAFE_INTEGER)
            let reservation = pipe.request("reserve", obj([("call_key", text("harness/${nextCall}")), ("tool_id", text(name)), ("args", args)])).asObject()
            if (reservation.containsKey("pause_requested")) {
                require(pipe.protocol != "harness/v6")
                keys(reservation, ["pause_requested"])
                require(field(reservation, "pause_requested").asBool().getValue())
                pendingModel = m
                continue
            }
            keys(reservation, ["invocation_id"])
            let id = uuid(field(reservation, "invocation_id"))
            let result = pipe.request("invoke", obj([("invocation_id", text(id)), ("tool_id", text(name)), ("args", args)]))
            resultCheck(result, true, id, name)
            if (office) { officeResultMatches(name, args, result.asObject()) }
            let status = str(field(result.asObject(), "status"), 16)
            if (status == "unknown") { finish("failed", "TOOL_EFFECT_UNKNOWN"); return }
            nextCall++
            toolRefs.add(text(id))
            let deferFailure = (officeRun || (name == "feishu_docx_read" && pipe.protocol == "harness/v8")) && status == "failed"
            if (!deferFailure && status != "ok" && (!delegated || status == "failed")) {
                let code = errorCheck(field(result.asObject(), "error"))
                checkpoint()
                finish("failed", code)
                return
            }
            if (delegated && status == "denied") {
                let code = errorCheck(field(result.asObject(), "error"))
                if (code == "TOOL_FORBIDDEN" || code == "TOOL_DENIED") { hardDenied = code }
            }
            if (status == "ok") { acceptedReceipts.add(id) }
            let approvalId = pendingApproval(result)
            if (approvalId != "") {
                if (delegated) { delegatedDocumentCheck(name, result) }
                if (pipe.protocol == "harness/v8") {
                    let accepted = obj([("status", text("ok")), ("result", field(result.asObject(), "result"))])
                    let observation = obj([("view", text("full")), ("invocation_id", text(id)), ("tool_id", text(name)), ("result", accepted)])
                    let unit = ContextUnit(observation, false, false)
                    let historyContent: JsonValue = if (isNull(content)) { text("") } else { content }
                    unit.entries.add(obj([("role", text("assistant")), ("content", historyContent), ("tool_calls", calls)]))
                    unit.entries.add(obj([("role", text("tool")), ("tool_call_id", field(call, "id")), ("content", text(observation.toString()))]))
                    contextState.units.add(unit)
                }
                waiting = obj([("invocation_id", text(id)), ("approval_id", text(approvalId))])
                let checkpointRef = checkpoint()
                pipe.ack("suspend", obj([("checkpoint_ref", text(checkpointRef)), ("invocation_id", text(id)), ("approval_id", text(approvalId))]), "suspended")
                return
            }
            let accepted = if (status == "ok") {
                obj([("status", text("ok")), ("result", field(result.asObject(), "result"))])
            } else {
                obj([("status", text(status)), ("error", field(result.asObject(), "error"))])
            }
            let observation = obj([("view", text("full")), ("invocation_id", text(id)), ("tool_id", text(name)), ("result", accepted)])
            let unit = ContextUnit(observation, false, false)
            let historyContent: JsonValue = if (isNull(content)) { text("") } else { content }
            unit.entries.add(obj([("role", text("assistant")), ("content", historyContent), ("tool_calls", calls)]))
            let receiptContent = if (delegated) { modelObservationView(observation).toString() } else { result.toString() }
            unit.entries.add(obj([("role", text("tool")), ("tool_call_id", field(call, "id")), ("content", text(receiptContent))]))
            contextState.units.add(unit)
            if (deferFailure) {
                checkpoint()
                finish("failed", errorCheck(field(result.asObject(), "error")))
                return
            }
        }
    }
}
