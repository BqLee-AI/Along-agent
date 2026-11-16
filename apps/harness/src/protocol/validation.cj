package along_harness.protocol

import std.collection.*
import stdx.encoding.json.*

public const FRAME_LIMIT: Int64 = 1048576
public const SAFE_INTEGER: Int64 = 9007199254740991

public func require(ok: Bool): Unit {
    if (!ok) { throw Exception("invalid harness protocol") }
}
public func field(o: JsonObject, key: String): JsonValue { o.get(key).getOrThrow() }
public func str(v: JsonValue, max: Int64): String {
    let s = v.asString().getValue()
    if (s.size > max) {
        var units: Int64 = 0
        for (r in s.runes()) { units += if (UInt32(r) > 0xFFFF) { 2 } else { 1 } }
        require(units <= max)
    }
    return s
}
public func ref(v: JsonValue): String {
    let s = str(v, 128)
    require(s.size > 0)
    return s
}
public func integer(v: JsonValue, min: Int64): Int64 {
    // JSON permits integral exponential/decimal notation as well as integer literals.
    let n = v.asFloat().getValue()
    require(n >= Float64(min) && n <= Float64(SAFE_INTEGER))
    let i = Int64(n)
    require(Float64(i) == n)
    return i
}
public func uuid(v: JsonValue): String {
    let s = str(v, 36)
    let b = s.toArray()
    require(b.size == 36)
    for (i in 0..36) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { require(b[i] == b'-') }
        else { require((b[i] >= b'0' && b[i] <= b'9') || (b[i] >= b'a' && b[i] <= b'f') || (b[i] >= b'A' && b[i] <= b'F')) }
    }
    return s
}
public func keys(o: JsonObject, names: Array<String>): Unit {
    require(o.size() == names.size)
    for (name in names) { require(o.containsKey(name)) }
}
public func sourceKeys(o: JsonObject, names: Array<String>): Unit {
    let extra: Int64 = if (o.containsKey("workspace_id")) { 1 } else { 0 }
    require(o.size() == names.size + extra)
    for (name in names) { require(o.containsKey(name)) }
    if (extra == 1) { nonempty(field(o, "workspace_id"), FRAME_LIMIT) }
}
public func obj(pairs: Array<(String, JsonValue)>): JsonObject {
    let o = JsonObject()
    for ((k, v) in pairs) { o.put(k, v) }
    return o
}
public func text(s: String): JsonString { JsonString(s) }
public func isNull(v: JsonValue): Bool {
    match (v.kind()) { case JsNull => true; case _ => false }
}
public func hash(v: JsonValue): String {
    let s = str(v, 64)
    require(s.size == 64)
    for (b in s.toArray()) { require((b >= b'0' && b <= b'9') || (b >= b'a' && b <= b'f')) }
    return s
}
public func routingIntent(v: JsonValue): String {
    let s = ref(v)
    require(s == "task_list_bounded" || s == "prefs_timezone_read" || s == "brief_cards_read")
    return s
}
public func routingTool(intent: String): String {
    if (intent == "task_list_bounded") { return "list_tasks" }
    if (intent == "prefs_timezone_read") { return "get_user_prefs" }
    require(intent == "brief_cards_read")
    return "read_brief_cards"
}
public func strings(v: JsonValue, intents: Bool): HashSet<String> {
    let result = HashSet<String>()
    for (item in v.asArray().getItems()) { require(result.add(if (intents) { routingIntent(item) } else { ref(item) })) }
    if (intents) { require(result.size <= 3) }
    return result
}
public func routingScore(v: JsonValue): Float64 {
    let n = v.asFloat().getValue()
    require(n >= -1.0 && n <= 1.0)
    return n
}
public func routingPolicyCheck(v: JsonValue): Unit {
    if (isNull(v)) { return }
    let p = v.asObject()
    require(ref(field(p, "revision")) == "r2b/1")
    let mode = ref(field(p, "mode"))
    if (mode == "off") { keys(p, ["revision", "mode"]); return }
    require(mode == "shadow" || mode == "enforce")
    keys(p, ["revision", "mode", "bundle_sha256", "encoding_sha256", "candidate_intents", "direct_intents", "thresholds", "competition", "deadline_ms", "max_inflight", "guard_revision", "parser_revision", "handler_revision", "renderer_revision", "scorer_revision"])
    hash(field(p, "bundle_sha256")); hash(field(p, "encoding_sha256"))
    let candidates = strings(field(p, "candidate_intents"), true)
    let direct = strings(field(p, "direct_intents"), true)
    let competition = strings(field(p, "competition"), false)
    require(competition.size >= 2 && (mode != "shadow" || direct.size == 0))
    for (intent in candidates) { require(competition.contains(intent)) }
    for (intent in direct) { require(candidates.contains(intent)) }
    let thresholds = field(p, "thresholds").asObject()
    keys(thresholds, ["task_list_bounded", "prefs_timezone_read", "brief_cards_read"])
    for (intent in ["task_list_bounded", "prefs_timezone_read", "brief_cards_read"]) {
        let t = field(thresholds, intent).asObject()
        keys(t, ["tau_intent", "tau_gap"])
        routingScore(field(t, "tau_intent"))
        let gap = field(t, "tau_gap").asFloat().getValue()
        require(gap >= 0.0 && gap <= 2.0)
    }
    require(integer(field(p, "deadline_ms"), 1000) == 1000 && integer(field(p, "max_inflight"), 2) == 2)
    for (name in ["guard_revision", "parser_revision", "handler_revision", "renderer_revision", "scorer_revision"]) { ref(field(p, name)) }
}
public func usageCheck(v: JsonValue): Unit {
    let o = v.asObject()
    keys(o, ["iterations", "tokens"])
    integer(field(o, "iterations"), 0)
    if (!isNull(field(o, "tokens"))) { integer(field(o, "tokens"), 0) }
}
public func refsCheck(v: JsonValue): Unit {
    let a = v.asArray()
    require(a.size() <= 64)
    let seen = HashSet<String>()
    for (x in a.getItems()) { require(seen.add(uuid(x))) }
}
public func waitingCheck(v: JsonValue): Unit {
    if (!isNull(v)) {
        let w = v.asObject()
        keys(w, ["invocation_id", "approval_id"])
        uuid(field(w, "invocation_id")); uuid(field(w, "approval_id"))
    }
}
public func snapshotCheck(v: JsonValue): Unit {
    let o = v.asObject()
    let version = integer(field(o, "version"), 2)
    require(version == 2 || version == 3)
    if (version == 3) {
        keys(o, ["version", "message_refs", "tool_refs", "next_call_no", "usage", "waiting", "native_state"])
    } else {
        keys(o, ["version", "message_refs", "tool_refs", "next_call_no", "usage", "waiting"])
    }
    refsCheck(field(o, "message_refs")); refsCheck(field(o, "tool_refs"))
    integer(field(o, "next_call_no"), 1)
    usageCheck(field(o, "usage")); waitingCheck(field(o, "waiting"))
}
public func errorCheck(v: JsonValue): String {
    let e = v.asObject()
    keys(e, ["code", "message"])
    str(field(e, "message"), 8192)
    return ref(field(e, "code"))
}
public func workspacePath(v: JsonValue): String {
    let s = str(v, FRAME_LIMIT)
    require(s.size > 0)
    let bytes = s.toArray()
    var segment: Int64 = 0
    var dots: Int64 = 0
    for (b in bytes) {
        require(b >= 32 && b != 92 && b != 58)
        if (b == 47) {
            require(segment > 0 && !(segment == dots && dots <= 2))
            segment = 0; dots = 0
        } else {
            segment++
            if (b == 46) { dots++ }
        }
    }
    require(segment > 0 && !(segment == dots && dots <= 2))
    return s
}
public func workspaceCheck(v: JsonValue): Unit {
    if (isNull(v)) { return }
    let w = v.asObject()
    if (w.containsKey("output_directories")) {
        keys(w, ["workspace_id", "label", "readable_paths", "writable_paths", "output_directories"])
        let outputs = HashSet<String>()
        for (p in field(w, "output_directories").asArray().getItems()) {
            let path = str(p, FRAME_LIMIT)
            if (path != "") { workspacePath(p) }
            require(outputs.add(path))
        }
    } else {
        keys(w, ["workspace_id", "label", "readable_paths", "writable_paths"])
    }
    require(str(field(w, "workspace_id"), FRAME_LIMIT).size > 0)
    require(str(field(w, "label"), FRAME_LIMIT).size > 0)
    let readable = HashSet<String>()
    for (p in field(w, "readable_paths").asArray().getItems()) { require(readable.add(workspacePath(p))) }
    let writable = HashSet<String>()
    for (p in field(w, "writable_paths").asArray().getItems()) {
        let path = workspacePath(p)
        require(writable.add(path) && readable.contains(path))
    }
}

public func nonempty(v: JsonValue, max: Int64): String {
    let s = str(v, max)
    require(s.size > 0)
    return s
}
public func utcCheck(v: JsonValue): Unit {
    let b = str(v, 64).toArray()
    require(b.size == 20)
    require(b[4] == b'-' && b[7] == b'-' && b[10] == b'T' &&
        b[13] == b':' && b[16] == b':' && b[b.size - 1] == b'Z')
    for (i in 0..b.size) {
        if (i == 4 || i == 7 || i == 10 || i == 13 || i == 16 || i == b.size - 1) { continue }
        require(b[i] >= b'0' && b[i] <= b'9')
    }
    let year = Int64(b[0] - b'0') * 1000 + Int64(b[1] - b'0') * 100 + Int64(b[2] - b'0') * 10 + Int64(b[3] - b'0')
    let month = Int64(b[5] - b'0') * 10 + Int64(b[6] - b'0')
    let day = Int64(b[8] - b'0') * 10 + Int64(b[9] - b'0')
    require(month >= 1 && month <= 12)
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    let days: Array<Int64> = [31, if (leap) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    require(day >= 1 && day <= days[month - 1])
    require(Int64(b[11] - b'0') * 10 + Int64(b[12] - b'0') <= 23)
    require(Int64(b[14] - b'0') * 10 + Int64(b[15] - b'0') <= 59)
    require(Int64(b[17] - b'0') * 10 + Int64(b[18] - b'0') <= 59)
}
public func trustedContextCheck(v: JsonValue): Unit {
    if (isNull(v)) { return }
    let t = v.asObject()
    if (t.containsKey("create_resolution_revision")) {
        keys(t, ["version", "authorization_revision", "execution_lifecycle", "input_message_id", "received_at_utc", "request_anchor_utc", "continuation", "timezone", "time_capabilities", "workspaces", "create_resolution_revision"])
        require(ref(field(t, "create_resolution_revision")) == "create-resolution/1" || ref(field(t, "create_resolution_revision")) == "create-resolution/2")
    } else {
        keys(t, ["version", "authorization_revision", "execution_lifecycle", "input_message_id", "received_at_utc", "request_anchor_utc", "continuation", "timezone", "time_capabilities", "workspaces"])
    }
    require(integer(field(t, "version"), 1) == 1)
    require(ref(field(t, "authorization_revision")) == "delegation/1")
    let lifecycle = ref(field(t, "execution_lifecycle"))
    require(lifecycle == "request-bound" || lifecycle == "server-owned")
    uuid(field(t, "input_message_id"))
    utcCheck(field(t, "received_at_utc")); utcCheck(field(t, "request_anchor_utc"))
    if (!isNull(field(t, "continuation"))) {
        let c = field(t, "continuation").asObject()
        if (c.containsKey("original_input_message_id")) {
            keys(c, ["run_id", "invocation_id", "original_input_message_id", "original_text", "goal_result", "receipts", "source_result"])
            uuid(field(c, "original_input_message_id"))
            nonempty(field(c, "original_text"), FRAME_LIMIT)
            if (!isNull(field(c, "goal_result"))) { field(c, "goal_result").asObject() }
        } else {
            keys(c, ["run_id", "invocation_id"])
        }
        uuid(field(c, "run_id"))
        if (!isNull(field(c, "invocation_id"))) { uuid(field(c, "invocation_id")) }
    }
    if (!isNull(field(t, "timezone"))) {
        let z = field(t, "timezone").asObject()
        keys(z, ["timezone_id", "source", "reference"])
        nonempty(field(z, "timezone_id"), 512); nonempty(field(z, "reference"), 128)
        let source = ref(field(z, "source"))
        require(source == "explicit" || source == "preference")
    }
    let time = field(t, "time_capabilities").asObject()
    keys(time, ["elapsed_revision", "wall_rules"])
    if (!isNull(field(time, "elapsed_revision"))) {
        require(ref(field(time, "elapsed_revision")) == "elapsed/1")
    }
    if (!isNull(field(time, "wall_rules"))) {
        let rules = field(time, "wall_rules").asObject()
        keys(rules, ["ruleset_id", "tzdb_version", "alias_version"])
        for (name in ["ruleset_id", "tzdb_version", "alias_version"]) { nonempty(field(rules, name), 128) }
    }
    let workspaceIds = HashSet<String>()
    for (workspace in field(t, "workspaces").asArray().getItems()) {
        require(!isNull(workspace))
        workspaceCheck(workspace)
        require(workspaceIds.add(str(field(workspace.asObject(), "workspace_id"), FRAME_LIMIT)))
    }
}
