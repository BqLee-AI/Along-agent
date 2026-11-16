package along_harness.session

import along_harness.protocol.*
import along_harness.transport.*

import std.collection.*
import stdx.encoding.json.*

// An accepted function pair is indivisible. Projection replaces the whole pair
// with ordinary, explicitly untrusted observation data, never fake tool calls.
class ContextUnit {
    var entries = JsonArray()
    var observation: JsonObject
    var seen: Bool
    var projected: Bool
    init(observation: JsonObject, seen: Bool, projected: Bool) {
        this.observation = observation
        this.seen = seen
        this.projected = projected
    }
}

// The model-visible conversation and its durable provenance move together.
class ConversationState {
    var messages = JsonArray()
    var protectedMessages = JsonArray()
    var historyMessages = JsonArray()
    var historyIndex: Int64 = 0
    var r3Context = JsonObject()
    var originalManifest = JsonObject()
    var originalSummary: JsonValue = JsonNull()
    var units = ArrayList<ContextUnit>()
    let messageRefs = JsonArray()
}

// Provider usage, limits, and measurement policy belong to one budget.
class BudgetState {
    var completionCap: Int64 = 1
    var modelWindow: Int64 = 0
    var reserveTokens: Int64 = 0
    var iterations: Int64 = 0
    var knownTokens: Int64 = 0
    var tokensKnown: Bool = true
    var maxIterations: Int64 = 1
    var maxTokens: Int64 = 1

    func usage(): JsonObject {
        var tokens: JsonValue = JsonNull()
        if (tokensKnown) { tokens = JsonInt(knownTokens) }
        return obj([("iterations", JsonInt(iterations)), ("tokens", tokens)])
    }

    func acceptUsage(v: JsonValue, previouslyKnown: Bool): Unit {
        tokensKnown = previouslyKnown
        if (isNull(v)) { tokensKnown = false; return }
        let u = v.asObject()
        keys(u, ["total_tokens"])
        let used = integer(field(u, "total_tokens"), 0)
        require(knownTokens <= SAFE_INTEGER - used)
        knownTokens += used
    }
}

protected class Harness {
    let pipe: Pipe
    let contextState = ConversationState()
    let budgetState = BudgetState()
    let toolRefs = JsonArray()
    let tools = HashSet<String>()
    var nextCall: Int64 = 1
    var waiting: JsonValue = JsonNull()
    var routingPolicy: JsonValue = JsonNull()
    var routingEligible: Bool = false
    var delegated: Bool = false
    var trustedWorkspaces = JsonArray()
    let workspaceIds = HashSet<String>()
    var hasWritableWorkspace: Bool = false
    var hasOutputWorkspace: Bool = false
    var hardDenied: String = ""
    var closingGoal: Bool = false
    let acceptedReceipts = HashSet<String>()
    var pendingModel: JsonValue = JsonNull()
    var restoredPause: Bool = false

    protected init(pipe: Pipe) { this.pipe = pipe }
}
