package along_harness.session

import along_harness.protocol.*
import std.collection.*
import stdx.encoding.json.*

extend Harness {
    func delegatedDocumentCheck(toolId: String, result: JsonValue): Unit {
        require(toolId == "workspace_propose_replace" && tools.contains(toolId) &&
            tools.contains("workspace_apply_replace") && hasWritableWorkspace)
        let payload = field(result.asObject(), "result").asObject()
        require(ref(field(payload, "kind")) == "document_approval")
        let approval = field(payload, "approval").asObject()
        let id = nonempty(field(approval, "workspace_id"), FRAME_LIMIT)
        let path = workspacePath(field(approval, "relative_path"))
        var allowed = false
        for (value in trustedWorkspaces.getItems()) {
            let workspace = value.asObject()
            if (str(field(workspace, "workspace_id"), FRAME_LIMIT) != id) { continue }
            for (item in field(workspace, "writable_paths").asArray().getItems()) {
                if (workspacePath(item) == path) { allowed = true }
            }
        }
        require(allowed)
    }
    func goalCheck(goal: JsonObject, checkReceipts: Bool): Unit {
        require(delegated)
        keys(goal, ["status", "outcomes", "clarification", "answer"])
        let status = ref(field(goal, "status"))
        require(status == "completed" || status == "partial" || status == "blocked" || status == "cancelled" || status == "unknown")
        nonempty(field(goal, "answer"), if (checkReceipts) { 8192 } else { FRAME_LIMIT })
        let outcomes = field(goal, "outcomes").asArray()
        require(outcomes.size() > 0 && outcomes.size() <= 64)
        var achieved: Int64 = 0
        var undone: Int64 = 0
        var unknown: Int64 = 0
        for (v in outcomes.getItems()) {
            let o = v.asObject()
            if (o.containsKey("create_resolution")) {
                keys(o, ["description", "status", "receipt_refs", "create_resolution"])
                let resolution = field(o, "create_resolution").asObject()
                keys(resolution, ["source_message_id", "source_quote", "zero_write_invocation_ids", "created_invocation_id", "read_invocation_id"])
                uuid(field(resolution, "source_message_id"))
                nonempty(field(resolution, "source_quote"), 8192)
                require(field(resolution, "zero_write_invocation_ids").asArray().size() > 0)
                refsCheck(field(resolution, "zero_write_invocation_ids"))
                uuid(field(resolution, "created_invocation_id"))
                uuid(field(resolution, "read_invocation_id"))
            } else {
                keys(o, ["description", "status", "receipt_refs"])
            }
            nonempty(field(o, "description"), 8192)
            let state = ref(field(o, "status"))
            if (state == "achieved") { achieved++ }
            else if (state == "not_done" || state == "blocked") { undone++ }
            else { require(state == "unknown"); unknown++ }
            refsCheck(field(o, "receipt_refs"))
            if (checkReceipts) {
                for (r in field(o, "receipt_refs").asArray().getItems()) { require(acceptedReceipts.contains(uuid(r))) }
            }
        }
        if (status == "completed") { require(undone == 0 && unknown == 0) }
        else if (status == "partial") { require(achieved > 0 && undone > 0 && unknown == 0) }
        else if (status == "blocked") { require(achieved == 0 && undone > 0 && unknown == 0) }
        else if (status == "unknown") { require(unknown > 0) }
        if (!isNull(field(goal, "clarification"))) {
            require(status == "partial" || status == "blocked")
            let c = field(goal, "clarification").asObject()
            keys(c, ["kind", "question"])
            let kind = ref(field(c, "kind"))
            require(kind == "time" || kind == "timezone" || kind == "target_selection" || kind == "destination")
            nonempty(field(c, "question"), 8192)
        }
    }
    // Model function arguments are untrusted control input, not pipe framing.
    // Only parse/schema/receipt checks are caught; transport failures remain fatal.
    func goalArguments(arguments: String): Option<JsonObject> {
        try {
            let goal = JsonValue.fromStr(arguments).asObject()
            goalCheck(goal, true)
            return Some(goal)
        } catch (_: Exception) {
            return None
        }
    }
    func observationCheck(o: JsonObject): Unit {
        let view = str(field(o, "view"), 16)
        uuid(field(o, "invocation_id")); ref(field(o, "tool_id"))
        if (view == "full") {
            keys(o, ["view", "invocation_id", "tool_id", "result"])
            resultCheck(field(o, "result"), false, "")
            return
        }
        require(view == "projected" && tools.contains("read_run_observation"))
        keys(o, ["view", "invocation_id", "tool_id", "outcome", "source"])
        require(str(field(o, "outcome"), 16) == "ok")
        let s = field(o, "source").asObject()
        require(integer(field(s, "result_version"), 1) == 1)
        require(field(s, "omitted").asBool().getValue())
        let kind = ref(field(s, "kind"))
        if (kind == "read") {
            sourceKeys(s, ["result_version", "omitted", "kind", "path", "version", "byte_length", "content_total"])
            str(field(s, "path"), FRAME_LIMIT); str(field(s, "version"), 64)
            integer(field(s, "byte_length"), 0); integer(field(s, "content_total"), 0)
        } else if (kind == "list" || kind == "search") {
            let totalKey = if (kind == "list") { "entries_total" } else { "matches_total" }
            sourceKeys(s, ["result_version", "omitted", "kind", "path", totalKey, "failures_total"])
            str(field(s, "path"), FRAME_LIMIT)
            integer(field(s, totalKey), 0); integer(field(s, "failures_total"), 0)
        } else {
            require(kind == "context_slice")
            let sourceKind = ref(field(s, "source_kind"))
            if (sourceKind == "read") {
                sourceKeys(s, ["result_version", "omitted", "kind", "source_invocation_id", "source_tool_id", "source_result_version", "source_kind", "field", "unit", "offset", "end", "total", "has_more", "path", "version", "byte_length"])
                str(field(s, "path"), FRAME_LIMIT); str(field(s, "version"), 64); integer(field(s, "byte_length"), 0)
            } else {
                require(sourceKind == "list" || sourceKind == "search")
                sourceKeys(s, ["result_version", "omitted", "kind", "source_invocation_id", "source_tool_id", "source_result_version", "source_kind", "field", "unit", "offset", "end", "total", "has_more"])
            }
            uuid(field(s, "source_invocation_id")); ref(field(s, "source_tool_id"))
            require(integer(field(s, "source_result_version"), 1) == 1)
            let fieldName = ref(field(s, "field"))
            require(fieldName == "content" || fieldName == "entries" || fieldName == "matches" || fieldName == "failures")
            let unit = ref(field(s, "unit"))
            require(unit == "unicode_scalar" || unit == "items")
            let offset = integer(field(s, "offset"), 0)
            require(integer(field(s, "end"), 0) >= offset)
            integer(field(s, "total"), 0); field(s, "has_more").asBool()
        }
        if (s.containsKey("workspace_id") && delegated) {
            require(workspaceIds.contains(str(field(s, "workspace_id"), FRAME_LIMIT)))
        }
    }
    func resultCheck(v: JsonValue, outcome: Bool, id: String): Unit {
        let o = v.asObject()
        let status = str(field(o, "status"), 16)
        require(status == "ok" || status == "denied" || status == "failed" || status == "unknown")
        let resultKey = if (status == "ok") { "result" } else { "error" }
        if (outcome) {
            keys(o, ["status", resultKey, "invocationId", "replayed"])
            require(uuid(field(o, "invocationId")) == id)
            field(o, "replayed").asBool()
        } else { keys(o, ["status", resultKey]) }
        if (status == "ok") {
            let payload = field(o, "result").asObject()
            let kind = ref(field(payload, "kind"))
            if (kind == "timezone_setting") {
                keys(payload, ["kind", "timezone_id", "previous_timezone_id", "alias_version"])
                for (name in ["timezone_id", "previous_timezone_id"]) {
                    if (!isNull(field(payload, name))) { nonempty(field(payload, name), 512) }
                }
                nonempty(field(payload, "alias_version"), 512)
            }
            else if (kind == "memory_source") { require(false) }
            else if (kind == "memory_saved") {
                require(pipe.protocol == "harness/v7")
                keys(payload, ["kind", "memory_id", "content"])
                uuid(field(payload, "memory_id")); nonempty(field(payload, "content"), 12000)
            }
            else if (kind == "memory_recall") {
                require(pipe.protocol == "harness/v7")
                keys(payload, ["kind", "items", "completeness"])
                let completeness = ref(field(payload, "completeness"))
                require(completeness == "complete" || completeness == "degraded" || completeness == "incomplete")
                let items = field(payload, "items").asArray()
                require(items.size() <= 50)
                for (value in items.getItems()) {
                    let item = value.asObject()
                    if (item.containsKey("match")) {
                        keys(item, ["memory_id", "content", "conversation_id", "message_ids", "created_at", "updated_at", "match"])
                        let matchKind = ref(field(item, "match"))
                        require(matchKind == "literal" || matchKind == "unfiltered")
                    } else {
                        keys(item, ["memory_id", "content", "conversation_id", "message_ids", "created_at", "updated_at"])
                    }
                    uuid(field(item, "memory_id")); nonempty(field(item, "content"), 12000)
                    uuid(field(item, "conversation_id"))
                    let ids = field(item, "message_ids").asArray()
                    require(ids.size() >= 1 && ids.size() <= 128)
                    let seen = HashSet<String>()
                    for (id in ids.getItems()) { require(seen.add(uuid(id))) }
                    nonempty(field(item, "created_at"), 64); nonempty(field(item, "updated_at"), 64)
                }
            }
            else if (kind == "task_created") {
                let elapsed = payload.containsKey("time_basis") || payload.containsKey("display_version")
                if (elapsed) {
                    keys(payload, ["kind", "task_id", "state", "wall_time", "timezone_id", "fold", "resolved_utc_offset_seconds", "tzdb_version", "fire_at_utc", "original_note", "time_basis", "display_version"])
                    require(ref(field(payload, "display_version")) == "elapsed/1")
                    let basis = field(payload, "time_basis").asObject()
                    keys(basis, ["kind", "anchor_utc", "duration_seconds", "source_message_id", "revision"])
                    require(ref(field(basis, "kind")) == "elapsed")
                    utcCheck(field(basis, "anchor_utc"))
                    integer(field(basis, "duration_seconds"), 1)
                    uuid(field(basis, "source_message_id"))
                    require(ref(field(basis, "revision")) == "elapsed/1")
                } else {
                    keys(payload, ["kind", "task_id", "state", "wall_time", "timezone_id", "fold", "resolved_utc_offset_seconds", "tzdb_version", "fire_at_utc", "original_note"])
                }
                uuid(field(payload, "task_id"))
                require(ref(field(payload, "state")) == "saved")
                for (name in ["wall_time", "timezone_id", "fire_at_utc"]) { str(field(payload, name), 512) }
                let fold = integer(field(payload, "fold"), 0)
                require(fold <= 1)
                let offset = integer(field(payload, "resolved_utc_offset_seconds"), -SAFE_INTEGER)
                if (isNull(field(payload, "tzdb_version"))) {
                    require(elapsed && str(field(payload, "timezone_id"), 512) == "UTC" && fold == 0 && offset == 0)
                } else { str(field(payload, "tzdb_version"), 512) }
                if (!isNull(field(payload, "original_note"))) { str(field(payload, "original_note"), 8192) }
            }
            else if (kind == "create_applied" || kind == "create_conflict" || kind == "create_failed") {
                if (kind == "create_applied") {
                    keys(payload, ["kind", "workspace_id", "path", "invocation_id", "args_hash", "version", "byte_length", "evidence_ref"])
                    nonempty(field(payload, "version"), FRAME_LIMIT)
                    integer(field(payload, "byte_length"), 0)
                    nonempty(field(payload, "evidence_ref"), FRAME_LIMIT)
                } else {
                    keys(payload, ["kind", "workspace_id", "path", "invocation_id", "args_hash", "reason", "zero_write"])
                    let reason = ref(field(payload, "reason"))
                    require((kind == "create_conflict" && reason == "already_exists") || (kind == "create_failed" && reason == "unavailable"))
                    require(field(payload, "zero_write").asBool().getValue())
                }
                nonempty(field(payload, "workspace_id"), FRAME_LIMIT)
                workspacePath(field(payload, "path"))
                let invocation = uuid(field(payload, "invocation_id"))
                if (outcome) { require(invocation == id) }
                nonempty(field(payload, "args_hash"), FRAME_LIMIT)
            }
        }
        else { errorCheck(field(o, "error")) }
    }
    func pendingApproval(v: JsonValue): String {
        let o = v.asObject()
        if (str(field(o, "status"), 16) != "ok") { return "" }
        let r = field(o, "result").asObject()
        let kind = ref(field(r, "kind"))
        if (kind == "approval") { return uuid(field(field(r, "approval").asObject(), "approvalId")) }
        if (kind == "document_approval") { return uuid(field(field(r, "approval").asObject(), "approval_id")) }
        return ""
    }
}
