package along_harness.session

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

class ConversationState {
    var messages = JsonArray()
    let protectedMessages = JsonArray()
    let units = ArrayList<ContextUnit>()
    let messageRefs = JsonArray()
}

class BudgetState {
    var completionCap: Int64 = 1
    var modelWindow: Int64 = 0
    var reserveTokens: Int64 = 0
    var iterations: Int64 = 0
    var knownTokens: Int64 = 0
    var tokensKnown: Bool = true
    var maxIterations: Int64 = 1
    var maxTokens: Int64 = 1
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

    protected init(pipe: Pipe) { this.pipe = pipe }
}
