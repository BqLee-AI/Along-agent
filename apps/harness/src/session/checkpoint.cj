package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*
import stdx.encoding.json.*

extend Harness {
    func context(): JsonObject {
        return obj([("version", JsonInt(2)), ("message_refs", contextState.messageRefs), ("tool_refs", toolRefs),
            ("next_call_no", JsonInt(nextCall)), ("usage", usage()), ("waiting", waiting)])
    }
    func checkpoint(): String {
        let reply = pipe.request("snapshot", obj([("context", context())])).asObject()
        keys(reply, ["checkpoint_ref"])
        return uuid(field(reply, "checkpoint_ref"))
    }
    protected func finish(outcome: String, code: String): Unit {
        require(!delegated || outcome != "done")
        let p = obj([("outcome", text(outcome)), ("usage", usage())])
        if (code != "") { p.put("error", obj([("code", text(code)), ("message", text("Harness stopped: ${code}"))])) }
        pipe.ack("finish", p, "accepted")
    }
}
