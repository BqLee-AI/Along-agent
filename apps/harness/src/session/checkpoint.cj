package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*
import stdx.encoding.json.*

extend Harness {
    func context(): JsonObject {
        return obj([("version", JsonInt(2)), ("message_refs", contextState.messageRefs), ("tool_refs", toolRefs),
            ("next_call_no", JsonInt(nextCall)), ("usage", usage()), ("waiting", waiting)])
    }
    func pausePoint(): Bool {
        if (pipe.protocol == "harness/v6") { return false }
        let probe = pipe.request("pause_probe", JsonObject()).asObject()
        keys(probe, ["pending"])
        if (!field(probe, "pending").asBool().getValue()) { return false }
        require(isNull(waiting))
        let units = JsonArray()
        for (unit in contextState.units) {
            units.add(obj([("entries", unit.entries), ("observation", unit.observation),
                ("seen", JsonBool(unit.seen)), ("projected", JsonBool(unit.projected))]))
        }
        let state = obj([("protected_messages", contextState.protectedMessages), ("units", units),
            ("hard_denied", text(hardDenied)), ("closing_goal", JsonBool(closingGoal)), ("pending_model", pendingModel)])
        let snapshot = context()
        snapshot.put("version", JsonInt(3))
        snapshot.put("native_state", state)
        let reply = pipe.request("pause_point", obj([("context", snapshot)])).asObject()
        keys(reply, ["paused"])
        return field(reply, "paused").asBool().getValue()
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
