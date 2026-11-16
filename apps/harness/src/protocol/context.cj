package along_harness.protocol

import std.collection.*
import stdx.encoding.json.*

public func r3Check(v: JsonValue): Unit {
    let c = v.asObject()
    keys(c, ["manifest", "summary", "messages", "input"])
    let manifest = field(c, "manifest").asObject()
    keys(manifest, ["message_ids"])
    let ids = field(manifest, "message_ids").asArray()
    require(ids.size() <= 4096)
    let all = HashSet<String>()
    for (id in ids.getItems()) { require(all.add(uuid(id))) }
    let covered = HashSet<String>()
    let summary = field(c, "summary")
    var coveredIds = JsonArray()
    if (!isNull(summary)) {
        let s = summary.asObject()
        keys(s, ["id", "revision", "text", "message_ids"])
        uuid(field(s, "id"))
        let rev = nonempty(field(s, "revision"), 128).toArray()
        require(rev[0] >= b'1' && rev[0] <= b'9')
        for (b in rev) { require(b >= b'0' && b <= b'9') }
        str(field(s, "text"), FRAME_LIMIT)
        coveredIds = field(s, "message_ids").asArray()
        for (id in coveredIds.getItems()) { require(covered.add(uuid(id)) && all.contains(uuid(id))) }
    }
    let messages = field(c, "messages").asArray()
    let uncovered = HashSet<String>()
    for (value in messages.getItems()) {
        let m = value.asObject()
        keys(m, ["message_id", "role", "content"])
        let id = uuid(field(m, "message_id"))
        require(uncovered.add(id) && all.contains(id) && !covered.contains(id))
        let role = str(field(m, "role"), 16)
        require(role == "user" || role == "assistant")
        str(field(m, "content"), FRAME_LIMIT)
    }
    require(covered.size + uncovered.size == all.size)
    var ci: Int64 = 0
    var mi: Int64 = 0
    for (value in ids.getItems()) {
        let id = uuid(value)
        if (covered.contains(id)) { require(uuid(coveredIds.get(ci).getOrThrow()) == id); ci++ }
        else { require(uuid(field(messages.get(mi).getOrThrow().asObject(), "message_id")) == id); mi++ }
    }
    let input = field(c, "input").asObject()
    let kind = ref(field(input, "type"))
    if (kind == "user") {
        keys(input, ["type", "message_id", "content"])
        require(!all.contains(uuid(field(input, "message_id"))))
        str(field(input, "content"), FRAME_LIMIT)
    } else { require(kind == "compact_control"); keys(input, ["type"]) }
}
