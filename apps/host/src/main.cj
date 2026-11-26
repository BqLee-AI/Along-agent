package along_host

import std.convert.*
import std.process.*
import std.io.*
import stdx.encoding.json.*
import stdx.net.http.*

let notReady = "{\"status\":\"not_ready\",\"reason\":\"NOT_READY\"}"

func checkReadiness(): (UInt16, String) {
    try {
        let (exitCode, bytes, _) = executeWithOutput(
            "/usr/bin/timeout", ["--kill-after=1s", "3s", "bun", "/app/apps/api/dist/bin/host-readiness.js"],
            stdErr: Inherit
        )
        if (exitCode != 0 || bytes.size > 4096) { return (503, notReady) }
        let body = String.fromUtf8(bytes)
        let status = JsonValue.fromStr(body).asObject().get("status").getOrThrow().asString().getValue()
        return (if (status == "ok") { 200 } else { 503 }, body)
    } catch (_: Exception) {
        return (503, notReady)
    }
}

foreign func along_install_stop_handlers(): Int32
foreign func along_stop_requested(): Int32

class ReadinessEvents <: InputStream {
    let data: Array<Byte>
    var offset = 0

    init(body: String) {
        data = ("event: readiness\ndata: " + body + "\n\n").toArray()
    }

    public func read(buffer: Array<Byte>): Int64 {
        let size = min(buffer.size, data.size - offset)
        for (i in 0..size) { buffer[i] = data[offset + i] }
        offset += size
        return size
    }
}

main(args: Array<String>) {
    let port: UInt16 = if (args.size == 0) { 3000 } else { UInt16.parse(args[0]) }
    let server = ServerBuilder().addr("0.0.0.0").port(port).build()
    server.distributor.register("/healthz", { ctx =>
        ctx.responseBuilder.header("Content-Type", "application/json").body("{\"status\":\"ok\"}")
    })
    server.distributor.register("/readyz", { ctx =>
        let (status, body) = checkReadiness()
        ctx.responseBuilder.status(status).header("Content-Type", "application/json").body(body)
    })
    server.distributor.register("/readyz/events", { ctx =>
        let (_, body) = checkReadiness()
        ctx.responseBuilder.header("Content-Type", "text/event-stream")
            .header("Transfer-Encoding", "chunked").body(ReadinessEvents(body))
    })
    if (unsafe { along_install_stop_handlers() } != 0) {
        throw Exception("cannot install host stop handlers")
    }
    spawn {
        while (unsafe { along_stop_requested() } == 0) { sleep(50 * Duration.millisecond) }
        server.closeGracefully()
    }
    server.serve()
}
