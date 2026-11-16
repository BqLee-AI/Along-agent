package along_harness.protocol

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
public func errorCheck(v: JsonValue): String {
    let e = v.asObject()
    keys(e, ["code", "message"])
    str(field(e, "message"), 8192)
    return ref(field(e, "code"))
}
public func nonempty(v: JsonValue, max: Int64): String {
    let s = str(v, max)
    require(s.size > 0)
    return s
}
