package along_host

import std.convert.*
import std.io.*
import std.net.*
import stdx.encoding.json.*
import stdx.net.http.*

let finiteUploadLimit = 131072

func isAccountPath(path: String): Bool {
    return path == "/api/v1/me" || path.startsWith("/api/v1/auth/") ||
        path == "/api/v1/model-selection/actions/set-default" ||
        path == "/api/v1/model-providers" ||
        (path.startsWith("/api/v1/model-providers/") &&
         path != "/api/v1/model-providers/actions/summarize-notes")
}

// One byte beyond the JSON cap preserves the validator's streamed-overflow result.
class FiniteUpload <: InputStream {
    let source: InputStream
    let length: Int64
    var remaining: Int64
    var ended = false

    init(source: InputStream, length: Int64) {
        this.source = source
        this.length = length
        remaining = if (length < 0) { finiteUploadLimit + 1 } else { length }
    }

    public func read(buffer: Array<Byte>): Int64 {
        if (remaining == 0) { return 0 }
        let count = source.read(buffer.slice(0, min(remaining, buffer.size)))
        if (count == 0) { ended = true }
        remaining -= count
        return count
    }

    func complete(): Bool { ended || (length >= 0 && remaining == 0) }
}

// The capability reads the upload only after the existing TS admission checks.
func forwardUpload(incoming: HttpRequest, outgoing: HttpRequestBuilder): (?FiniteUpload, Bool) {
    if (incoming.method != "POST" && incoming.method != "PUT") {
        return (None, incoming.headers.getFirst("transfer-encoding") != None ||
            (incoming.headers.getFirst("content-length") ?? "0") != "0")
    }
    if (let Some(length) <- incoming.headers.getFirst("content-length")) {
        let count = Int64.parse(length)
        if (count > finiteUploadLimit) {
            outgoing.header("x-along-host-body-length", length)
            return (None, true)
        }
        if (count <= 0) { return (None, false) }
        let stream = FiniteUpload(incoming.body, count)
        outgoing.header("expect", "100-continue").header("content-length", length).body(stream)
        return (Some(stream), false)
    }
    if (incoming.headers.getFirst("transfer-encoding") != None || incoming.version != Protocol.HTTP1_1) {
        let stream = FiniteUpload(incoming.body, -1)
        outgoing.header("expect", "100-continue").header("transfer-encoding", "chunked").body(stream)
        return (Some(stream), false)
    }
    return (None, false)
}

func finishFinite(ctx: HttpContext, body: String, unread: Bool, connection: ?FiniteConnection): Unit {
    if (unread) {
        if (let Some(bound) <- connection) {
            // stdx drains unread input before it sends a normal handler response.
            let bytes = body.toArray()
            ctx.responseBuilder.header("connection", "close").header("content-length", bytes.size.toString())
            HttpResponseWriter(ctx).write(bytes)
            sleep(250 * Duration.millisecond)
            bound.close()
            return
        }
    }
    ctx.responseBuilder.body(body)
}

func serveFinite(ctx: HttpContext, socketPath: String, operation: String,
                 encrypted!: Bool = false, listener!: ?FiniteListener = None): Unit {
    let id = requestId(ctx)
    let client = privateClient(socketPath, readTimeout: 35 * Duration.second)
    let peer = ctx.request.remoteAddr
    let connection = listener.flatMap { bound => bound.connectionFor(peer) }
    try {
        let target = "http://localhost" + ctx.request.url.rawPath + (match (ctx.request.url.rawQuery) {
            case Some(query) => "?" + query
            case None => ""
        })
        let request = HttpRequestBuilder().method(ctx.request.method).url(target)
            .header("x-request-id", id).header("x-along-host-operation", operation)
        if (encrypted) { request.header("x-along-host-tls", "1") }
        if (let Some(inet) <- IPSocketAddress.tryParse(peer)) {
            request.header("x-along-host-peer", inet.address.toString())
            if (let Some(bound) <- connection) {
                request.header("x-along-host-local", bound.localIp)
            }
        }
        for (name in ["cookie", "authorization", "x-csrf-token", "idempotency-key", "content-type",
                      "accept", "origin", "x-along-local-model-proxy"]) {
            var combined = ""
            for (value in ctx.request.headers.get(name)) {
                if (combined.isEmpty()) {
                    combined = value
                } else if (name != "authorization" && name != "content-type") {
                    combined += (if (name == "cookie") { "; " } else { ", " }) + value
                }
            }
            if (!combined.isEmpty()) { request.header(name, combined) }
        }
        let (upload, skipped) = forwardUpload(ctx.request, request)
        let reply = client.send(request.build())
        let body = if (ctx.request.method == "HEAD") { "" } else { boundedBody(reply) }
        // add preserves separate Set-Cookie fields, including Expires commas.
        let headers = HttpHeaders()
        for (name in ["content-type", "cache-control", "x-request-id", "retry-after", "set-cookie"]) {
            for (value in reply.headers.get(name)) { headers.add(name, value) }
        }
        ctx.responseBuilder.status(reply.status).addHeaders(headers)
        finishFinite(ctx, body, skipped || upload.map { stream => !stream.complete() }.getOrDefault({ => false }), connection)
    } catch (_: Exception) {
        // Exceptions from the HTTP libraries may carry request data. Emit a fixed envelope.
        let error = JsonObject()
        error.put("code", JsonString("NOT_READY"))
        error.put("message", JsonString("service not ready"))
        error.put("request_id", JsonString(id))
        let envelope = JsonObject()
        envelope.put("code", JsonValue.fromStr("503"))
        envelope.put("data", JsonNull())
        envelope.put("msg", JsonString("service not ready"))
        envelope.put("error", error)
        envelope.put("request_id", JsonString(id))
        ctx.responseBuilder.status(503).header("x-request-id", id)
            .header("cache-control", "no-store").header("content-type", "application/json")
            .body(envelope.toString())
    } finally {
        client.close()
    }
}
