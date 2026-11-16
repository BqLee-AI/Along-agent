package along_harness.protocol

import std.collection.*
import stdx.encoding.json.*

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
