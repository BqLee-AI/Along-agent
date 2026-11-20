package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*

import std.collection.*
import stdx.encoding.json.*

extend Harness {
    func factsCheck(f: JsonObject, policy: JsonObject): Unit {
        keys(f, ["facts_ref", "input_sha256", "bundle_sha256", "eligible", "reason", "rule_intent", "candidates"])
        uuid(field(f, "facts_ref")); hash(field(f, "input_sha256"))
        require(hash(field(f, "bundle_sha256")) == hash(field(policy, "bundle_sha256")))
        let eligible = field(f, "eligible").asBool().getValue()
        if (!isNull(field(f, "reason"))) { ref(field(f, "reason")) }
        let intents = strings(field(policy, "candidate_intents"), true)
        let seen = HashSet<String>()
        for (item in field(f, "candidates").asArray().getItems()) {
            let c = item.asObject()
            keys(c, ["intent", "tool_id", "args", "sources"])
            let intent = routingIntent(field(c, "intent"))
            require(seen.add(intent) && intents.contains(intent))
            require(ref(field(c, "tool_id")) == routingTool(intent))
            field(c, "args").asObject()
            for (source in field(c, "sources").asArray().getItems()) {
                let s = source.asObject()
                ref(field(s, "field"))
                require(ref(field(s, "parser_revision")) == ref(field(policy, "parser_revision")))
                let origin = ref(field(s, "source"))
                if (origin == "contract_default") {
                    keys(s, ["field", "source", "parser_revision"])
                } else {
                    require(origin == "message")
                    keys(s, ["field", "source", "message_id", "raw", "start", "end", "parser_revision"])
                    let messageId = uuid(field(s, "message_id"))
                    require(messageId == uuid(contextState.messageRefs.get(contextState.messageRefs.size() - 1).getOrThrow()))
                    let start = integer(field(s, "start"), 0)
                    let end = integer(field(s, "end"), 0)
                    var count: Int64 = 0
                    for (r in str(field(s, "raw"), FRAME_LIMIT).runes()) { count++ }
                    require(end >= start && end - start == count)
                }
            }
        }
        if (!isNull(field(f, "rule_intent"))) { require(eligible && seen.contains(routingIntent(field(f, "rule_intent")))) }
    }
    func embeddingChoice(facts: JsonObject, policy: JsonObject): String {
        let evidence = pipe.request("route_probe", obj([("stage", text("embedding")), ("facts_ref", field(facts, "facts_ref"))])).asObject()
        keys(evidence, ["facts_ref", "input_sha256", "bundle_sha256", "reason", "scores"])
        require(uuid(field(evidence, "facts_ref")) == uuid(field(facts, "facts_ref")))
        require(hash(field(evidence, "input_sha256")) == hash(field(facts, "input_sha256")))
        require(hash(field(evidence, "bundle_sha256")) == hash(field(facts, "bundle_sha256")))
        let competition = strings(field(policy, "competition"), false)
        let seen = HashSet<String>()
        var best = -2.0
        var second = -2.0
        var exclusion = -2.0
        var winner = ""
        for (item in field(evidence, "scores").asArray().getItems()) {
            let entry = item.asObject()
            keys(entry, ["intent", "score", "exclusion_score"])
            let intent = ref(field(entry, "intent"))
            require(competition.contains(intent) && seen.add(intent))
            let score = routingScore(field(entry, "score"))
            var veto = -2.0
            if (!isNull(field(entry, "exclusion_score"))) { veto = routingScore(field(entry, "exclusion_score")) }
            if (score > best) {
                second = best; best = score; winner = intent; exclusion = veto
            } else if (score > second) { second = score }
        }
        if (!isNull(field(evidence, "reason"))) { ref(field(evidence, "reason")); return "" }
        require(seen.size == competition.size)
        if (best == second || exclusion == -2.0 || exclusion >= best) { return "" }
        let candidates = strings(field(policy, "candidate_intents"), true)
        if (!candidates.contains(winner)) { return "" }
        var hasArgs = false
        for (c in field(facts, "candidates").asArray().getItems()) {
            if (routingIntent(field(c.asObject(), "intent")) == winner) { hasArgs = true }
        }
        if (!hasArgs) { return "" }
        let threshold = field(field(policy, "thresholds").asObject(), winner).asObject()
        if (best < routingScore(field(threshold, "tau_intent")) || best - second < field(threshold, "tau_gap").asFloat().getValue()) { return "" }
        return winner
    }
    // Once direct is acknowledged, no failure path can return to the model loop.
    func routeFirstStep(): Bool {
        if (!routingEligible || isNull(routingPolicy) || budgetState.iterations != 0 || toolRefs.size() != 0) { return false }
        let policy = routingPolicy.asObject()
        let mode = ref(field(policy, "mode"))
        if (mode == "off") { return false }
        let facts = pipe.request("route_probe", obj([("stage", text("facts")), ("facts_ref", JsonNull())])).asObject()
        factsCheck(facts, policy)
        var intent = ""
        var reason = "INELIGIBLE"
        if (field(facts, "eligible").asBool().getValue()) {
            if (!isNull(field(facts, "rule_intent"))) {
                intent = routingIntent(field(facts, "rule_intent")); reason = "RULE_MATCH"
            } else { intent = embeddingChoice(facts, policy); reason = "EMBEDDING_MATCH" }
            if (intent == "") { reason = "NO_MATCH" }
        }
        let direct = mode == "enforce" && intent != "" && strings(field(policy, "direct_intents"), true).contains(intent)
        if (mode == "shadow") { reason = "SHADOW" }
        else if (intent != "" && !direct) { reason = "INTENT_DISABLED" }
        let decision = if (direct) { "direct" } else { "fallback" }
        let candidateIntent: JsonValue = if (direct) { text(intent) } else { JsonNull() }
        let decisionRequest = obj([("decision", text(decision)), ("facts_ref", field(facts, "facts_ref")), ("candidate_intent", candidateIntent), ("reason", text(reason))])
        var receipt = pipe.request("route_decide", decisionRequest).asObject()
        while (receipt.containsKey("pause_requested")) {
            require(pipe.protocol != "harness/v6")
            keys(receipt, ["pause_requested"])
            require(field(receipt, "pause_requested").asBool().getValue())
            if (pausePoint()) { return true }
            receipt = pipe.request("route_decide", decisionRequest).asObject()
        }
        keys(receipt, ["decision_ref", "decision", "intent", "tool_id", "args"])
        let decisionRef = uuid(field(receipt, "decision_ref"))
        require(ref(field(receipt, "decision")) == decision)
        if (!direct) {
            require(isNull(field(receipt, "intent")) && isNull(field(receipt, "tool_id")) && isNull(field(receipt, "args")))
            return false
        }
        require(routingIntent(field(receipt, "intent")) == intent)
        let name = ref(field(receipt, "tool_id"))
        require(name == routingTool(intent) && tools.contains(name))
        let args = field(receipt, "args").asObject()
        var matched = false
        for (c in field(facts, "candidates").asArray().getItems()) {
            if (routingIntent(field(c.asObject(), "intent")) == intent) {
                require(field(c.asObject(), "args").toString() == args.toString())
                matched = true
            }
        }
        require(matched && nextCall < SAFE_INTEGER && toolRefs.size() < 64)
        let reservation = pipe.request("reserve", obj([("call_key", text("harness/${nextCall}")), ("tool_id", text(name)), ("args", args)])).asObject()
        keys(reservation, ["invocation_id"])
        let id = uuid(field(reservation, "invocation_id"))
        let result = pipe.request("invoke", obj([("invocation_id", text(id)), ("tool_id", text(name)), ("args", args)]))
        resultCheck(result, true, id, name)
        let status = ref(field(result.asObject(), "status"))
        if (status == "unknown") { finish("failed", "TOOL_EFFECT_UNKNOWN"); return true }
        nextCall++
        toolRefs.add(text(id))
        if (status != "ok") {
            checkpoint()
            finish("failed", errorCheck(field(result.asObject(), "error")))
            return true
        }
        let kind = ref(field(field(result.asObject(), "result").asObject(), "kind"))
        let expectedKind = if (intent == "task_list_bounded") { "list_tasks" } else if (intent == "prefs_timezone_read") { "prefs" } else { "brief" }
        require(kind == expectedKind)
        checkpoint()
        pipe.ack("render_route_result", obj([("decision_ref", text(decisionRef)), ("invocation_ref", text(id)), ("template_revision", field(policy, "renderer_revision"))]), "rendered")
        pipe.ack("finish", obj([("outcome", text("done")), ("usage", budgetState.usage())]), "accepted")
        return true
    }
}
