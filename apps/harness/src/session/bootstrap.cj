package along_harness.session

import along_harness.protocol.*

import std.collection.*
import stdx.encoding.json.*

extend Harness {
    protected func bootstrap(start: JsonObject): Bool {
        checkStartFrame(start)
        let trusted = field(start, "trusted_context")
        admitTrust(start, trusted)
        admitPolicyAndTools(start)
        bootstrapPrompts(start, trusted)
        let input = bootstrapInput(start, trusted)
        let observations = field(start, "observations").asArray()
        let observationIds = HashSet<String>()
        let bootstrapFailure = restoreObservations(start, observations, observationIds)
        restoreSnapshot(start, input, observations)
        return resumeApproval(start, observations, observationIds, bootstrapFailure)
    }
}
