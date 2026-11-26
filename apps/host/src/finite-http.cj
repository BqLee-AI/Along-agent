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
    var remaining = finiteUploadLimit + 1

    init(source: InputStream) { this.source = source }

    public func read(buffer: Array<Byte>): Int64 {
        if (remaining == 0) { return 0 }
        let count = source.read(buffer.slice(0, min(remaining, buffer.size)))
        remaining -= count
        return count
    }
}

func serveFinite(ctx: HttpContext, socketPath: String, operation: String,
                 encrypted!: Bool = false, listener!: ?FiniteListener = None): Unit {
    let id = requestId(ctx)
    let client = privateClient(socketPath, readTimeout: 35 * Duration.second)
    try {
        let target = "http://localhost" + ctx.request.url.rawPath + (match (ctx.request.url.rawQuery) {
            case Some(query) => "?" + query
            case None => ""
        })
        let request = HttpRequestBuilder().method(ctx.request.method).url(target)
            .header("x-request-id", id).header("x-along-host-operation", operation)
        if (encrypted) { request.header("x-along-host-tls", "1") }
        let peer = ctx.request.remoteAddr
        if (let Some(inet) <- IPSocketAddress.tryParse(peer)) {
            request.header("x-along-host-peer", inet.address.toString())
            if (let Some(bound) <- listener) {
                if (let Some(local) <- bound.localFor(peer)) {
                    request.header("x-along-host-local", local)
                }
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
        if (ctx.request.method == "POST") {
            match (ctx.request.headers.getFirst("content-length")) {
                case Some(length) =>
                    if (Int64.parse(length) > finiteUploadLimit) {
                        // The private validator still sees the declared size after auth/CSRF.
                        request.header("x-along-host-body-length", length)
                    } else if (length != "0") {
                        request.header("content-length", length).body(ctx.request.body)
                    }
                case None =>
                    if (ctx.request.headers.getFirst("transfer-encoding") != None ||
                        ctx.request.version != Protocol.HTTP1_1) {
                        request.header("transfer-encoding", "chunked").body(FiniteUpload(ctx.request.body))
                    }
            }
        }
        let reply = client.send(request.build())
        let body = if (ctx.request.method == "HEAD") { "" } else { boundedBody(reply) }
        // add preserves separate Set-Cookie fields, including Expires commas.
        let headers = HttpHeaders()
        for (name in ["content-type", "cache-control", "x-request-id", "retry-after", "set-cookie"]) {
            for (value in reply.headers.get(name)) { headers.add(name, value) }
        }
        ctx.responseBuilder.status(reply.status).addHeaders(headers).body(body)
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
