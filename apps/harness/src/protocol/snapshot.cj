package along_harness.protocol

import std.collection.*
import stdx.encoding.json.*

public func usageCheck(v: JsonValue): Unit {
    let o = v.asObject()
    keys(o, ["iterations", "tokens"])
    integer(field(o, "iterations"), 0)
    if (!isNull(field(o, "tokens"))) { integer(field(o, "tokens"), 0) }
}
public func refsCheck(v: JsonValue): Unit { boundedRefsCheck(v, 0, 64) }
public func boundedRefsCheck(v: JsonValue, min: Int64, max: Int64): Unit {
    let a = v.asArray()
    require(a.size() >= min && a.size() <= max)
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
    if (version == 4) {
        keys(o, ["version", "original_manifest", "original_summary", "context", "tool_refs", "next_call_no", "usage", "waiting", "native_state"])
    } else if (version == 3) { keys(o, ["version", "message_refs", "tool_refs", "next_call_no", "usage", "waiting", "native_state"]) }
    else { require(version == 2); keys(o, ["version", "message_refs", "tool_refs", "next_call_no", "usage", "waiting"]) }
    if (version != 4) { refsCheck(field(o, "message_refs")) }
    refsCheck(field(o, "tool_refs"))
    integer(field(o, "next_call_no"), 1)
    usageCheck(field(o, "usage")); waitingCheck(field(o, "waiting"))
}
