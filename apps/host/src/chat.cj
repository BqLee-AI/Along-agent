package along_host

import std.convert.*
import std.collection.*
import std.net.*
import stdx.encoding.json.*
import stdx.net.http.*

let messagesPath = "/api/v1/conversations/messages"

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

    init(socketPath: String) { this.socketPath = socketPath }

    public func register(path: String, handler: HttpRequestHandler): Unit {
        routes.add(path, handler)
    }

    public func distribute(path: String): HttpRequestHandler {
        if (let Some(route) <- routes.get(path)) { return route }
        let parts = path.split("/")
        if (parts.size == 7 && parts[0].isEmpty() && parts[1] == "api" &&
            parts[2] == "v1" && !parts[4].isEmpty() && parts[5] == "actions" &&
            ((parts[3] == "approvals" && parts[6] == "confirm") ||
             (parts[3] == "tasks" && parts[6] == "cancel"))) {
            return FuncHandler({ ctx => serveReminderAction(ctx, socketPath, path) })
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
    let body = boundedBody(reply, maximum: 6 * 1048576 + 64)
    if (reply.status != 200) { throw Exception("Run capability rejected " + operation) }
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

func serveBusinessChat(ctx: HttpContext, socketPath: String): Unit {
    let id = requestId(ctx)
    let builder = ctx.responseBuilder.header("x-request-id", id).header("cache-control", "no-store")
    if (ctx.request.method != "POST") {
        builder.status(404).body("")
        return
    }
    let client = privateClient(socketPath)
    try {
        let admitted = forwardPublicPost(ctx, client, messagesPath, id, "admit")
        let body = boundedBody(admitted)
        if (admitted.status != 200) {
            builder.status(admitted.status).header("content-type", "application/json").body(body)
            return
        }
        let run = JsonValue.fromStr(body).asObject()
        let lease = jsonText(run, "lease")
        let step = { operation: String, input: JsonValue =>
            runCapabilityStep(client, "/business/step", id, lease, operation, input)
        }
        if (let Some(native) <- run.get("native")) {
            let nativeLease = native.asString().getValue()
            spawn { driveNativeRun(socketPath, id, nativeLease) }
        }
        try {
            builder.header("content-type", "text/event-stream")
                .header("cache-control", "no-cache, no-transform")
                .header("x-conversation-id", jsonText(run, "conversationId"))
                .header("x-run-id", jsonText(run, "runId"))
                .header("transfer-encoding", "chunked")
            let writer = HttpResponseWriter(ctx)
            let emit = { event: JsonValue =>
                if (ctx.isClosed()) { throw Exception("SSE disconnected") }
                writer.write(("data: " + event.toString() + "\n\n").toArray())
            }
            if (run.get("subscription").getOrThrow().asBool().getValue()) {
                while (!ctx.isClosed()) {
                    let frame = step("replay", JsonNull())
                    if (businessNull(frame)) { break }
                    writer.write(frame.asString().getValue().toArray())
                }
            } else if (run.get("replay").getOrThrow().asBool().getValue()) {
                while (!ctx.isClosed()) {
                    let event = step("replay", JsonNull())
                    if (businessNull(event)) { break }
                    emit(event)
                }
            } else {
                emit(step("start", JsonNull()))
                advanceBusinessRun(run.get("facts").getOrThrow().asObject(),
                    { tool: String => step("invoke", JsonString(tool)).asObject() },
                    { kind: String, payload: JsonObject =>
                        emit(step("publish", businessPayload([("type", JsonString(kind)), ("payload", payload)])))
                    })
            }
        } finally {
            try { step("close", JsonNull()) } catch (_: Exception) {}
        }
    } finally {
        client.close()
    }
}
