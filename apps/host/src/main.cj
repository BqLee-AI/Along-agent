package along_host

import std.convert.*
import std.env.*
import std.fs.*
import std.net.*
import std.process.*
import std.io.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.crypto.keys.*
import stdx.crypto.x509.*
import stdx.net.tls.*

let notReady = "{\"status\":\"not_ready\",\"reason\":\"NOT_READY\"}"

func requestId(ctx: HttpContext): String {
    let incoming = ctx.request.headers.getFirst("x-request-id").getOrDefault({ => "" }).trimAscii()
    if (!incoming.isEmpty() && incoming.size <= 200) { return incoming }
    return newId()
}

func newId(): String {
    let file = File("/proc/sys/kernel/random/uuid", OpenMode.Read)
    try {
        let bytes = Array<Byte>(37, repeat: 0)
        return String.fromUtf8(bytes.slice(0, file.read(bytes))).trimAscii()
    } finally {
        file.close()
    }
}

func callWorkerPhase(socketPath: String, phase: String, workerId: String): Bool {
    let client = ClientBuilder().connector({ _: SocketAddress =>
        let socket = UnixSocket(socketPath)
        socket.connect()
        socket
    }).build()
    try {
        let request = HttpRequestBuilder().post().url("http://localhost/worker/" + phase)
            .header("x-request-id", workerId + ":" + phase).header("x-worker-id", workerId).build()
        return client.send(request).status == 204
    } catch (_: Exception) {
        return false
    } finally {
        client.close()
    }
}

func checkReadiness(socketPath: String, id: String): (UInt16, String) {
    let client = ClientBuilder().connector({ _: SocketAddress =>
        let socket = UnixSocket(socketPath)
        socket.connect()
        socket
    }).readTimeout(3 * Duration.second).writeTimeout(3 * Duration.second).build()
    try {
        let request = HttpRequestBuilder().get().url("http://localhost/readiness")
            .header("x-request-id", id).build()
        let response = client.send(request)
        if (response.headers.getFirst("x-request-id") != Some(id) ||
            (response.status != 200 && response.status != 503)) { return (503, notReady) }
        let length = Int64.parse(response.headers.getFirst("content-length").getOrThrow())
        if (length <= 0 || length > 4096) { return (503, notReady) }
        let bytes = Array<Byte>(length, repeat: 0)
        var offset = 0
        while (offset < length) {
            let read = response.body.read(bytes.slice(offset, length - offset))
            if (read <= 0) { return (503, notReady) }
            offset += read
        }
        let body = String.fromUtf8(bytes)
        let status = JsonValue.fromStr(body).asObject().get("status").getOrThrow().asString().getValue()
        if (status != (if (response.status == 200) { "ok" } else { "not_ready" })) {
            return (503, notReady)
        }
        return (response.status, body)
    } catch (_: Exception) {
        return (503, notReady)
    } finally {
        client.close()
    }
}

foreign func along_install_stop_handlers(): Int32
foreign func along_stop_requested(): Int32

class ReadinessEvents <: InputStream {
    let socketPath: String
    let id: String
    var data = ": readiness\n\n".toArray()
    var offset = 0
    var resultSent = false

    init(socketPath: String, id: String) {
        this.socketPath = socketPath
        this.id = id
    }

    public func read(buffer: Array<Byte>): Int64 {
        if (offset == data.size && !resultSent) {
            let (_, body) = checkReadiness(socketPath, id)
            data = ("event: readiness\ndata: " + body + "\n\n").toArray()
            offset = 0
            resultSent = true
        }
        let size = min(buffer.size, data.size - offset)
        for (i in 0..size) { buffer[i] = data[offset + i] }
        offset += size
        return size
    }
}

main(args: Array<String>) {
    let port = UInt16.parse(if (args.size == 0) { getVariable("PORT") ?? "3000" } else { args[0] })
    let role = (getVariable("ROLE") ?? "all").trimAscii().toAsciiLower()
    if (role != "api" && role != "worker" && role != "all") {
        throw Exception("invalid ROLE: expected api, worker or all")
    }
    if (unsafe { along_install_stop_handlers() } != 0) {
        throw Exception("cannot install host stop handlers")
    }
    let directory = Directory.createTemp("/tmp")
    let socketPath = directory.toString() + "/capability.sock"
    try {
        let capability = launch("bun", ["/app/apps/api/dist/bin/host-readiness.js", socketPath, role], stdIn: Pipe)
        try {
            for (_ in 0..100) {
                if (exists(socketPath) || stopping()) { break }
                sleep(20 * Duration.millisecond)
            }
            if (stopping()) { return }
            let work = { =>
                runWorker(
                    { phase: String, id: String => callWorkerPhase(socketPath, phase, id) },
                    "worker-" + newId(),
                    stopping
                )
            }
            if (role == "worker") {
                work()
            } else if (role == "all") {
                let worker = spawn { work() }
                serve(port, socketPath)
                worker.get()
            } else {
                serve(port, socketPath)
            }
        } finally {
            capability.terminate()
            try {
                capability.wait(timeout: 4 * Duration.second)
            } catch (_: TimeoutException) {
                capability.terminate(force: true)
                capability.wait()
            }
        }
    } finally {
        remove(directory, recursive: true)
    }
}

func stopping(): Bool {
    return unsafe { along_stop_requested() } != 0
}

func serve(port: UInt16, socketPath: String): Unit {
    let builder = ServerBuilder().addr("0.0.0.0").port(port).distributor(HostDistributor(socketPath))
    match ((getVariable("ALONG_HOST_TLS_CERT"), getVariable("ALONG_HOST_TLS_KEY"))) {
        case (Some(cert), Some(key)) =>
            builder.tlsConfig(TlsServerConfig(
                X509Certificate.decodeFromPem(String.fromUtf8(File.readFrom(cert))),
                RSAPrivateKey.decodeFromPem(String.fromUtf8(File.readFrom(key)))
            ))
        case (None, None) => ()
        case _ => throw Exception("configure both host TLS certificate and key paths")
    }
    let server = builder.build()
    server.distributor.register("/healthz", { ctx =>
        ctx.responseBuilder.header("x-request-id", requestId(ctx))
        ctx.responseBuilder.header("Content-Type", "application/json").body("{\"status\":\"ok\"}")
    })
    server.distributor.register("/readyz", { ctx =>
        let id = requestId(ctx)
        let (status, body) = checkReadiness(socketPath, id)
        ctx.responseBuilder.status(status).header("x-request-id", id)
            .header("Content-Type", "application/json").body(body)
    })
    server.distributor.register("/readyz/events", { ctx =>
        let id = requestId(ctx)
        ctx.responseBuilder.header("x-request-id", id).header("Content-Type", "text/event-stream")
            .header("Transfer-Encoding", "chunked").body(ReadinessEvents(socketPath, id))
    })
    spawn {
        while (!stopping()) { sleep(50 * Duration.millisecond) }
        server.closeGracefully()
    }
    server.serve()
}
