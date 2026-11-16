package along_harness.protocol

import std.collection.*
import stdx.encoding.json.*

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
