package along_host

import stdx.encoding.json.*
import stdx.net.http.*

func conversationOperation(path: String, method: String): String {
    let root = "/api/v1/conversations"
    if (path == root) { return if (method == "GET") { "list" } else { "" } }
    if (path == root + "/messages" && method == "POST") { return "send" }
    let parts = path.split("/")
    if (parts.size < 5 || parts[4].isEmpty()) { return "" }
    if (method == "GET") {
        if (parts.size == 5) { return "detail" }
        if (parts.size == 6 && parts[5] == "messages") { return "messages" }
        if (parts[5] != "runs") { return "" }
        if (parts.size == 6) { return "runs" }
        if (parts[6].isEmpty()) { return "" }
        if (parts.size == 7) { return "status" }
        if (parts.size == 8 && parts[7] == "events") { return "events" }
        if (parts.size == 9 && parts[7] == "compacts" && !parts[8].isEmpty()) { return "compact-receipt" }
    } else if (method == "POST") {
        if (parts.size == 7 && parts[5] == "actions" && parts[6] == "compact") { return "compact-idle" }
        if (parts.size == 9 && parts[5] == "runs" && !parts[6].isEmpty() && parts[7] == "actions") {
            match (parts[8]) {
                case "cancel" | "pause" | "resume" | "continue" => return parts[8]
                case "compact" => return "compact-active"
                case _ => ()
            }
        }
    }
    return ""
}

func serveConversation(ctx: HttpContext, socketPath: String, listener: FiniteListener): Unit {
    let path = ctx.request.url.rawPath
    let operation = conversationOperation(path, ctx.request.method)
    if (operation.isEmpty()) {
        serveFinite(ctx, socketPath, "fallback", listener: Some(listener))
        return
    }
    let id = requestId(ctx)
    let builder = ctx.responseBuilder.header("x-request-id", id)
    let client = privateClient(socketPath)
    try {
        let (request, upload, skipped) = requestConversation(ctx, path, id, operation)
        let admitted = client.send(request)
        if (admitted.headers.getFirst("x-request-id") != Some(id)) { throw Exception("mismatched Run response") }
        if (let Some(native) <- admitted.headers.getFirst("x-native-handoff")) {
            spawn { driveNativeRun(socketPath, id, native) }
        }
        let body = boundedBody(admitted, maximum: 16 * 1048576)
        if (admitted.status != 200 || admitted.headers.getFirst("x-run-stream") != Some("1")) {
            builder.status(admitted.status).header("content-type", "application/json")
                .header("cache-control", "no-store")
            let unread = skipped || upload.map { stream => !stream.complete() }.getOrDefault({ => false })
            finishFinite(ctx, body, unread, listener.connectionFor(ctx.request.remoteAddr))
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
            let heartbeat = ": keepalive\n\n".toArray()
            let emit = { event: JsonValue =>
                if (ctx.isClosed()) { throw Exception("SSE disconnected") }
                writer.write(("data: " + event.toString() + "\n\n").toArray())
            }
            if (run.get("subscribed").getOrThrow().asBool().getValue()) {
                var cursor = run.get("afterSeq").getOrThrow()
                var drain = false
                while (!ctx.isClosed() && !stopping()) {
                    let result = step(if (drain) { "drain" } else { "poll" }, cursor).asObject()
                    match (jsonText(result, "status")) {
                        case "event" =>
                            writer.write(("data: " + jsonText(result, "json") + "\n\n").toArray())
                            cursor = result.get("seq").getOrThrow()
                        case "withheld" => cursor = result.get("seq").getOrThrow()
                        case "settled" => drain = true
                        case "pending" =>
                            writer.write(heartbeat)
                            sleep(500 * Duration.millisecond)
                        case "done" => break
                        case _ => throw Exception("invalid replay status")
                    }
                }
            } else if (run.get("streamed").getOrThrow().asBool().getValue()) {
                while (!ctx.isClosed()) {
                    let event = step("replay", JsonNull())
                    if (businessNull(event)) { break }
                    match (event.kind()) {
                        case JsString => writer.write(heartbeat)
                        case _ => emit(event)
                    }
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

func requestConversation(ctx: HttpContext, path: String, id: String, operation: String): (HttpRequest, ?FiniteUpload, Bool) {
    let target = "http://localhost" + path + (match (ctx.request.url.rawQuery) {
        case Some(query) => "?" + query
        case None => ""
    })
    let post = ctx.request.method == "POST"
    let request = (if (post) { HttpRequestBuilder().post() } else { HttpRequestBuilder().get() })
        .url(target).header("x-request-id", id).header("x-along-conversation-operation", operation)
    for (name in ["cookie", "authorization", "x-csrf-token", "idempotency-key", "content-type"]) {
        if (let Some(value) <- ctx.request.headers.getFirst(name)) { request.header(name, value) }
    }
    let (upload, skipped) = forwardUpload(ctx.request, request)
    return (request.build(), upload, skipped)
}
