package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*

import std.collection.*
import stdx.encoding.json.*

extend Harness {
    func checkStartFrame(start: JsonObject): Unit {
        if (pipe.protocol == "harness/v8") {
            if (start.containsKey("mode")) {
                require(pipe.measureOnly && ref(field(start, "mode")) == "measure_only")
                require(!isNull(field(start, "snapshot")) && isNull(field(start, "approval")))
                let s = field(start, "snapshot").asObject()
                require(integer(field(s, "version"), 2) == 4 && isNull(field(s, "waiting")))
                if (start.containsKey("workspace")) {
                    keys(start, ["protocol", "type", "mode", "r3_context", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "workspace", "trusted_context"])
                    workspaceCheck(field(start, "workspace"))
                } else {
                    keys(start, ["protocol", "type", "mode", "r3_context", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "trusted_context"])
                }
            } else if (start.containsKey("workspace")) {
                keys(start, ["protocol", "type", "r3_context", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "workspace", "trusted_context"])
                workspaceCheck(field(start, "workspace"))
            } else {
                keys(start, ["protocol", "type", "r3_context", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "trusted_context"])
            }
        } else if (start.containsKey("workspace")) {
            keys(start, ["protocol", "type", "messages", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "workspace", "trusted_context"])
            workspaceCheck(field(start, "workspace"))
        } else {
            keys(start, ["protocol", "type", "messages", "tools", "budget", "context_policy", "routing_policy", "eligible_phase", "snapshot", "observations", "approval", "trusted_context"])
        }
        require(str(field(start, "type"), 32) == "start")
    }
    func admitTrust(start: JsonObject, trusted: JsonValue): Unit {
        trustedContextCheck(trusted)
        delegated = !isNull(trusted)
        if (delegated) {
            require(!start.containsKey("workspace") || isNull(field(start, "workspace")))
            trustedWorkspaces = field(trusted.asObject(), "workspaces").asArray()
            for (value in trustedWorkspaces.getItems()) {
                let workspace = value.asObject()
                workspaceIds.add(str(field(workspace, "workspace_id"), FRAME_LIMIT))
                if (field(workspace, "writable_paths").asArray().size() > 0) { hasWritableWorkspace = true }
                if (workspace.containsKey("output_directories") && field(workspace, "output_directories").asArray().size() > 0) { hasOutputWorkspace = true }
            }
        }
        if (delegated && !isNull(field(trusted.asObject(), "continuation"))) {
            let continuation = field(trusted.asObject(), "continuation").asObject()
            if (continuation.containsKey("goal_result")) {
                let receipts = field(continuation, "receipts").asArray()
                require(receipts.size() <= 4096)
                let receiptIds = HashSet<String>()
                for (value in receipts.getItems()) {
                    let receipt = value.asObject()
                    keys(receipt, ["invocation_id", "tool_id", "result"])
                    require(receiptIds.add(uuid(field(receipt, "invocation_id"))))
                    let toolId = ref(field(receipt, "tool_id"))
                    require(toolId != "feishu_docx_read")
                    resultCheck(field(receipt, "result"), false, "", toolId)
                    require(ref(field(field(receipt, "result").asObject(), "status")) == "ok")
                    acceptedReceipts.add(uuid(field(receipt, "invocation_id")))
                }
                if (!isNull(field(continuation, "source_result"))) {
                    let source = field(continuation, "source_result").asObject()
                    keys(source, ["invocation_id", "tool_id", "result"])
                    uuid(field(source, "invocation_id"))
                    let toolId = ref(field(source, "tool_id"))
                    require(toolId != "feishu_docx_read")
                    resultCheck(field(source, "result"), false, "", toolId)
                }
                if (!isNull(field(continuation, "goal_result"))) {
                    let previous = field(continuation, "goal_result").asObject()
                    goalCheck(previous, false)
                    for (value in field(previous, "outcomes").asArray().getItems()) {
                        let outcome = value.asObject()
                        if (ref(field(outcome, "status")) == "achieved") {
                            for (receipt in field(outcome, "receipt_refs").asArray().getItems()) {
                                let id = uuid(receipt)
                                require(receiptIds.contains(id))
                                acceptedReceipts.add(id)
                            }
                        }
                    }
                }
            }
        }
    }
    func admitPolicyAndTools(start: JsonObject): Unit {
        policyCheck(field(start, "context_policy"))
        routingPolicy = field(start, "routing_policy")
        routingPolicyCheck(routingPolicy)
        let phase = ref(field(start, "eligible_phase"))
        require(phase == "fresh_first_step" || phase == "disabled")
        routingEligible = phase == "fresh_first_step" && isNull(field(start, "snapshot")) && isNull(field(start, "approval"))
        let budget = field(start, "budget").asObject()
        keys(budget, ["max_iterations", "max_tokens"])
        budgetState.maxIterations = integer(field(budget, "max_iterations"), 1)
        budgetState.maxTokens = integer(field(budget, "max_tokens"), 1)
        let definitions = field(start, "tools").asArray()
        require(definitions.size() <= 64)
        for (v in definitions.getItems()) {
            let t = v.asObject()
            keys(t, ["name", "description", "parameters", "risk"])
            require(tools.add(ref(field(t, "name"))))
            let name = ref(field(t, "name"))
            if (name == "read_memory_source") { require(pipe.protocol == "harness/v8") }
            if (name == "remember_memory" || name == "recall_memories") { require(pipe.protocol != "harness/v6") }
            if (name == "feishu_docx_read" || name == "learn_docs_search") { require(delegated) }
            require(delegated || (name != "create_reminder" && name != "get_task" && name != "cancel_reminder" && name != "workspace_replace" && name != "workspace_create"))
            if (delegated) {
                let workspaceRead = name == "workspace_list" || name == "workspace_grep" || name == "workspace_read"
                let workspaceWrite = name == "workspace_replace" || name == "workspace_propose_replace" || name == "workspace_apply_replace"
                let workspaceCreate = name == "workspace_create"
                require(name == "get_user_prefs" || name == "set_user_timezone" || name == "create_reminder" || name == "get_task" || name == "cancel_reminder" || name == "read_run_observation" || name == "list_tasks" || name == "read_brief_cards" || name == "feishu_docx_read" || name == "learn_docs_search" || (pipe.protocol != "harness/v6" && (name == "remember_memory" || name == "recall_memories")) || (pipe.protocol == "harness/v8" && name == "read_memory_source") || workspaceRead || workspaceWrite || workspaceCreate)
                if (workspaceRead) { require(workspaceIds.size > 0) }
                if (workspaceWrite) { require(hasWritableWorkspace) }
                if (workspaceCreate) { require(hasOutputWorkspace) }
            }
            str(field(t, "description"), 8192)
            field(t, "parameters").asObject()
            let risk = str(field(t, "risk"), 8)
            require(risk == "low" || risk == "medium" || risk == "high")
        }
    }
}
