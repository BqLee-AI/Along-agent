package along_harness

import along_harness.protocol.*
import along_harness.transport.*
import along_harness.session.*
import std.env.*
import stdx.encoding.json.*

main(args: Array<String>): Int64 {
    if (args.size != 0) {
        try {
            require(args.size == 1)
            let reply = match (args[0]) {
                case "compact-assemble/1" => assembleCompact(readCompactInput())
                case "compact-interpret/1" => interpretCompact(readCompactInput())
                case _ => throw Exception("unknown harness operation")
            }
            getStdOut().write(wireJson(reply) + "\n")
            getStdOut().flush()
            return 0
        } catch (_: Exception) {
            getStdErr().write("HARNESS_PROTOCOL_ERROR\n")
            return 2
        }
    }
    let pipe = Pipe()
    let harness = Harness(pipe)
    try {
        let start = pipe.checkedFrame()
        if (start.containsKey("mode")) {
            require(pipe.protocol == "harness/v8" && ref(field(start, "mode")) == "measure_only")
            pipe.measureOnly = true
        }
        if (harness.bootstrap(start)) {
            if (pipe.measureOnly) { harness.previewContext() } else { harness.loop() }
        }
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
