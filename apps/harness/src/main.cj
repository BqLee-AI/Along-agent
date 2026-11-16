package along_harness

import along_harness.transport.*
import along_harness.session.*
import std.env.*

main(): Int64 {
    let pipe = Pipe()
    let harness = Harness(pipe)
    try {
        if (harness.bootstrap(pipe.checkedFrame())) { harness.loop() }
        return 0
    } catch (_: Cancelled) {
        // Cancellation already committed in TS; do not manufacture a second terminal receipt.
        return 0
    } catch (e: RemoteFailure) {
        try { harness.finish("failed", e.code); return 0 } catch (_: Exception) { return 2 }
    } catch (_: Exception) {
        getStdErr().write("HARNESS_PROTOCOL_ERROR\n")
        return 2
    }
}
