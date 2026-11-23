package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*

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
    func policyCheck(v: JsonValue): Unit {
        let p = v.asObject()
        keys(p, ["revision", "completion_cap", "model_window_tokens", "input_meter", "meter_revision", "reserve_tokens", "model_binding"])
        require(ref(field(p, "revision")) == "r2a/1")
        budgetState.completionCap = integer(field(p, "completion_cap"), 1)
        if (!isNull(field(p, "model_window_tokens"))) { budgetState.modelWindow = integer(field(p, "model_window_tokens"), 1) }
        budgetState.reserveTokens = integer(field(p, "reserve_tokens"), 0)
        let quality = ref(field(p, "input_meter"))
        require(quality == "verified" || quality == "estimated" || quality == "unavailable")
        let revision = str(field(p, "meter_revision"), FRAME_LIMIT)
        require(revision.size > 0 && (quality == "unavailable" || revision != "unavailable/1"))
        let binding = field(p, "model_binding").asObject()
        keys(binding, ["model", "adapter_revision"])
        require(str(field(binding, "model"), FRAME_LIMIT).size > 0)
        require(str(field(binding, "adapter_revision"), FRAME_LIMIT).size > 0)
    }
    func observationCheck(o: JsonObject): Unit {
        let view = str(field(o, "view"), 16)
        uuid(field(o, "invocation_id"))
        let toolId = ref(field(o, "tool_id"))
        if (toolId == "feishu_docx_read") { require(tools.contains(toolId) && view == "full") }
        if (toolId == "learn_docs_search") { require(view == "full") }
        if (view == "full") {
            keys(o, ["view", "invocation_id", "tool_id", "result"])
            resultCheck(field(o, "result"), false, "", toolId)
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
    func feishuDocxCheck(payload: JsonObject): Unit {
        keys(payload, ["kind", "source", "revision", "fetched_at", "content_hash", "representation", "completeness", "content"])
        let source = field(payload, "source").asObject()
        keys(source, ["type", "url", "title", "identity"])
        require(ref(field(source, "identity")) == "bot")
        require(ref(field(source, "type")) == "feishu_docx")
        let url = str(field(source, "url"), 512)
        let prefix = "https://"
        let separator = ".feishu.cn/docx/"
        let documentStart = url.size - 27
        let hostEnd = documentStart - separator.size
        require(hostEnd > prefix.size && url.startsWith(prefix) && url[hostEnd..documentStart] == separator)
        for (i in prefix.size..hostEnd) {
            let b = url[i]
            require((b >= b'a' && b <= b'z') || (b >= b'0' && b <= b'9') || b == b'-')
        }
        for (i in documentStart..url.size) {
            let b = url[i]
            require((b >= b'a' && b <= b'z') || (b >= b'A' && b <= b'Z') || (b >= b'0' && b <= b'9'))
        }
        require(str(field(source, "title"), 8192).size <= 8192)

        let revision = field(payload, "revision").asObject()
        keys(revision, ["before", "after"])
        require(integer(field(revision, "before"), 1) == integer(field(revision, "after"), 1))
        fetchedAtCheck(field(payload, "fetched_at"))
        hash(field(payload, "content_hash"))
        require(ref(field(payload, "representation")) == "plain_text")
        require(ref(field(payload, "completeness")) == "complete_plain_text")
        require(str(field(payload, "content"), 240000).size <= 240000 && wireJson(payload).size <= 240000)
    }
    func fetchedAtCheck(value: JsonValue): Unit {
        let fetched = str(value, 24)
        require(fetched.size == 24 && fetched[19] == b'.' && fetched[23] == b'Z')
        for (i in 20..23) { require(fetched[i] >= b'0' && fetched[i] <= b'9') }
        utcCheck(text(fetched[0..19] + "Z"))
    }
    // Match ECMAScript whitespace for query blankness and URL validation.
    func learnWhitespace(code: UInt32): Bool {
        return (code >= 0x09 && code <= 0x0D) || code == 0x20 || code == 0xA0 ||
            code == 0x1680 || (code >= 0x2000 && code <= 0x200A) ||
            code == 0x2028 || code == 0x2029 || code == 0x202F || code == 0x205F ||
            code == 0x3000 || code == 0xFEFF
    }
    func learnUrlCheck(url: String): Unit {
        let prefix = "https://learn.microsoft.com"
        require(url.size >= prefix.size)
        for (i in 0..prefix.size) {
            let byte = url[i]
            require(byte == prefix[i] ||
                (byte >= b'A' && byte <= b'Z' && byte + 32 == prefix[i]))
        }
        var authorityEnd = prefix.size
        if (authorityEnd < url.size && url[authorityEnd] == b':') {
            authorityEnd++
            while (authorityEnd < url.size && url[authorityEnd] == b'0') { authorityEnd++ }
            require(authorityEnd + 3 <= url.size && url[authorityEnd..authorityEnd + 3] == "443")
            authorityEnd += 3
        }
        require(authorityEnd == url.size || url[authorityEnd] == b'/' ||
            url[authorityEnd] == b'?' || url[authorityEnd] == b'#')
        for (r in url.runes()) {
            let code = UInt32(r)
            require(code > 0x20 && code != 0x5C && code != 0x7F && !learnWhitespace(code))
        }
    }
    // Count compact JSON bytes from decoded text, including escape expansion.
    func learnJsonStringBytes(value: String): Int64 {
        var bytes = value.size + 2
        for (r in value.runes()) {
            let code = UInt32(r)
            require(code < 0xD800 || code > 0xDFFF)
            if (code == 0x22 || code == 0x5C || code == 8 || code == 9 ||
                code == 10 || code == 12 || code == 13) { bytes++ }
            else if (code < 0x20) { bytes += 5 }
        }
        return bytes
    }
    func learnSearchCheck(payload: JsonObject): Unit {
        keys(payload, ["kind", "query", "fetched_at", "representation", "items"])
        let query = field(payload, "query").asString().getValue()
        var length: Int64 = 0
        var nonblank = false
        for (r in query.runes()) {
            length++
            require(length <= 500)
            if (!nonblank && !learnWhitespace(UInt32(r))) { nonblank = true }
        }
        require(nonblank)
        fetchedAtCheck(field(payload, "fetched_at"))
        require(ref(field(payload, "representation")) == "search_excerpts")
        let items = field(payload, "items").asArray()
        require(items.size() <= 10)
        var bytes = "{\"kind\":\"learn_docs_search\",\"query\":,\"fetched_at\":\"0000-00-00T00:00:00.000Z\",\"representation\":\"search_excerpts\",\"items\":[]}".size +
            learnJsonStringBytes(query)
        if (items.size() > 0) { bytes += items.size() - 1 }
        for (value in items.getItems()) {
            let item = value.asObject()
            keys(item, ["title", "url", "content"])
            let title = field(item, "title").asString().getValue()
            let url = field(item, "url").asString().getValue()
            let content = field(item, "content").asString().getValue()
            require(title.size <= 512 && url.size <= 2048 && content.size <= 4096)
            learnUrlCheck(url)
            bytes += "{\"title\":,\"url\":,\"content\":}".size +
                learnJsonStringBytes(title) + learnJsonStringBytes(url) + learnJsonStringBytes(content)
            require(bytes <= 65536)
        }
    }
    func resultCheck(v: JsonValue, outcome: Bool, id: String, toolId: String): Unit {
        if (toolId == "feishu_docx_read" || toolId == "learn_docs_search") { require(delegated) }
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
            if (kind == "feishu_docx_read") {
                require(toolId == "feishu_docx_read")
                feishuDocxCheck(payload)
                return
            }
            if (kind == "learn_docs_search") {
                require(toolId == "learn_docs_search")
                learnSearchCheck(payload)
                return
            }
            require(toolId != "feishu_docx_read" && toolId != "learn_docs_search")
            if (kind == "timezone_setting") {
                keys(payload, ["kind", "timezone_id", "previous_timezone_id", "alias_version"])
                for (name in ["timezone_id", "previous_timezone_id"]) {
                    if (!isNull(field(payload, name))) { nonempty(field(payload, name), 512) }
                }
                nonempty(field(payload, "alias_version"), 512)
            }
            else if (kind == "memory_saved") {
                require(pipe.protocol != "harness/v6")
                keys(payload, ["kind", "memory_id", "content"])
                uuid(field(payload, "memory_id")); nonempty(field(payload, "content"), 12000)
            }
            else if (kind == "memory_recall") {
                require(pipe.protocol != "harness/v6")
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
                        require(matchKind == "literal" || matchKind == "unfiltered" || (pipe.protocol == "harness/v8" && matchKind == "semantic"))
                    } else {
                        keys(item, ["memory_id", "content", "conversation_id", "message_ids", "created_at", "updated_at"])
                    }
                    uuid(field(item, "memory_id")); nonempty(field(item, "content"), 12000)
                    uuid(field(item, "conversation_id")); boundedRefsCheck(field(item, "message_ids"), 1, 128)
                    nonempty(field(item, "created_at"), 64); nonempty(field(item, "updated_at"), 64)
                }
            }
            else if (kind == "memory_source") {
                require(pipe.protocol == "harness/v8")
                keys(payload, ["kind", "recall_invocation_id", "memory_id", "conversation_id", "message_id", "role", "content", "offset", "end", "total", "has_more"])
                for (name in ["recall_invocation_id", "memory_id", "conversation_id", "message_id"]) { uuid(field(payload, name)) }
                let role = ref(field(payload, "role"))
                require(role == "user" || role == "assistant")
                let content = str(field(payload, "content"), 8192)
                var length: Int64 = 0
                for (_ in content.runes()) { length++ }
                let offset = integer(field(payload, "offset"), 0)
                let end = integer(field(payload, "end"), 0)
                let total = integer(field(payload, "total"), 0)
                require(length <= 4096 && offset <= end && end <= total && end - offset == length)
                require(field(payload, "has_more").asBool().getValue() == (end < total))
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
