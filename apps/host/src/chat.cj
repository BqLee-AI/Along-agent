package along_host

import std.convert.*
import std.collection.*
import std.net.*
import stdx.encoding.json.*
import stdx.net.http.*

func privateClient(socketPath: String, readTimeout!: Duration = 10 * Duration.second): Client {
    return ClientBuilder().connector({ _: SocketAddress =>
        let socket = UnixSocket(socketPath)
        socket.connect()
        socket
    }).readTimeout(readTimeout).writeTimeout(10 * Duration.second).build()
}

func boundedBody(response: HttpResponse, maximum!: Int64 = 1048576): String {
    let length = Int64.parse(response.headers.getFirst("content-length").getOrThrow())
    if (length < 0 || length > maximum) { throw Exception("invalid capability response size") }
    let bytes = Array<Byte>(length, repeat: 0)
    var offset = 0
    while (offset < length) {
        let count = response.body.read(bytes.slice(offset, length - offset))
        if (count <= 0) { throw Exception("truncated capability response") }
        offset += count
    }
    return String.fromUtf8(bytes)
}

class HostDistributor <: HttpRequestDistributor {
    let routes = HashMap<String, HttpRequestHandler>()
    let socketPath: String
    let encrypted: Bool
    let listener: FiniteListener

    init(socketPath: String, encrypted: Bool, listener: FiniteListener) {
        this.socketPath = socketPath
        this.encrypted = encrypted
        this.listener = listener
    }

    public func register(path: String, handler: HttpRequestHandler): Unit {
        routes.add(path, handler)
    }

    public func distribute(path: String): HttpRequestHandler {
        if (let Some(route) <- routes.get(path)) { return route }
        let parts = path.split("/")
        if (parts.size >= 4 && parts[0].isEmpty() && parts[1] == "api" &&
            parts[2] == "v1" && parts[3] == "conversations") {
            return FuncHandler({ ctx => serveConversation(ctx, socketPath) })
        }
        if (parts.size == 7 && parts[0].isEmpty() && parts[1] == "api" &&
            parts[2] == "v1" && !parts[4].isEmpty() && parts[5] == "actions" &&
            ((parts[3] == "approvals" && parts[6] == "confirm") ||
             (parts[3] == "tasks" && parts[6] == "cancel"))) {
            return FuncHandler({ ctx => serveReminderAction(ctx, socketPath, path) })
        }
        if (isAccountPath(path)) {
            return FuncHandler({ ctx =>
                serveFinite(ctx, socketPath, "account", encrypted: encrypted, listener: Some(listener))
            })
        }
        return NotFoundHandler()
    }
}

func forwardPublicPost(ctx: HttpContext, client: Client, path: String, id: String, operation: String): HttpResponse {
    let request = HttpRequestBuilder().post().url("http://localhost" + path)
        .header("x-request-id", id)
    if (!operation.isEmpty()) { request.header("x-along-host-operation", operation) }
    for (name in ["cookie", "authorization", "x-csrf-token", "idempotency-key", "content-type"]) {
        if (let Some(value) <- ctx.request.headers.getFirst(name)) { request.header(name, value) }
    }
    match (ctx.request.headers.getFirst("content-length")) {
        case Some(length) => request.header("content-length", length)
        case None => request.header("transfer-encoding", "chunked")
    }
    return client.send(request.body(ctx.request.body).build())
}

func serveReminderAction(ctx: HttpContext, socketPath: String, path: String): Unit {
    if (ctx.request.method != "POST") {
        notFound(ctx)
        return
    }
    let id = requestId(ctx)
    let client = privateClient(socketPath)
    try {
        let reply = forwardPublicPost(ctx, client, path, id, "")
        ctx.responseBuilder.status(reply.status).header("x-request-id", id)
            .header("cache-control", "no-store").header("content-type", "application/json")
            .body(boundedBody(reply))
    } finally {
        client.close()
    }
}

func runCapabilityStep(client: Client, path: String, id: String, lease: String,
                       operation: String, input: JsonValue): JsonValue {
    let reply = client.send(HttpRequestBuilder().post().url("http://localhost" + path)
        .header("x-request-id", id).header("x-run-capability", lease)
        .header("x-run-operation", operation).header("content-type", "application/json")
        .body(input.toString()).build())
    if (reply.status != 200 || reply.headers.getFirst("x-request-id") != Some(id)) {
        throw Exception("Run capability rejected " + operation)
    }
    let body = boundedBody(reply, maximum: if (path == "/harness/step" && operation == "next") {
        64 * 1048576
    } else { 6 * 1048576 + 64 })
    return JsonValue.fromStr(body)
}

func driveNativeRun(socketPath: String, id: String, lease: String): Unit {
    let client = privateClient(socketPath, readTimeout: 305 * Duration.second)
    let step = { operation: String, input: JsonValue =>
        runCapabilityStep(client, "/harness/step", id, lease, operation, input)
    }
    try {
        while (!stopping()) {
            let next = step("next", JsonNull()).asObject()
            match (jsonText(next, "status")) {
                case "done" => return
                case "start" =>
                    var result = "ok"
                    try {
                        runHarness(jsonText(next, "frame"),
                            { frame => step("exchange", JsonString(frame)).asString().getValue() },
                            { => stopping() })
                    } catch (error: HarnessRunError) {
                        result = error.code
                    } catch (error: Exception) {
                        eprintln("[host harness] ${error.message}")
                        result = "HARNESS_EXITED"
                    }
                    step("exit", JsonString(result))
                case "compact" =>
                    let work = JsonObject()
                    work.put("id", next.get("id").getOrThrow())
                    try {
                        let output = runNativeCompact(jsonText(next, "operation"), jsonText(next, "input"))
                        work.put("output", JsonString(output))
                    } catch (error: Exception) {
                        eprintln("[host compact] ${error.message}")
                    }
                    step("compact-result", work)
                case "pending" => sleep(100 * Duration.millisecond)
                case _ => throw Exception("invalid Run capability status")
            }
        }
    } catch (error: Exception) {
        eprintln("[host harness bridge] ${error.message}")
        try { step("abandon", JsonNull()) } catch (_: Exception) {}
    } finally {
        client.close()
    }
}

