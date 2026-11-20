package along_harness.transport

import along_harness.protocol.*
import std.env.*
import std.collection.*
import stdx.encoding.json.*

// POSIX read returns available pipe bytes. The SDK's buffered stream read waits
// to fill its buffer, which deadlocks a request/reply pipe on short frames.
foreign func read(fd: Int32, buffer: CPointer<UInt8>, size: UIntNative): IntNative

func readAvailable(buffer: Array<UInt8>): Int64 {
    unsafe {
        let handle = acquireArrayRawData(buffer)
        try { return Int64(read(0, handle.pointer, UIntNative(buffer.size))) }
        finally { releaseArrayRawData(handle) }
    }
}

protected class Cancelled <: Exception {
    protected init() { super("cancelled") }
}
protected class RemoteFailure <: Exception {
    protected let code: String
    protected init(code: String) { super("request rejected"); this.code = code }
}

// Read at most 4KiB ahead, cap each frame before copying, and decode only complete frames.
// Raw EOF, including a complete frame without its LF, cannot acknowledge an action.
protected class Pipe {
    let chunk = Array<UInt8>(4096, repeat: 0)
    var offset: Int64 = 0
    var count: Int64 = 0
    protected var serial: Int64 = 0
    protected var protocol: String = ""
    protected var measureOnly: Bool = false
    protected var compactControl: Bool = false
    protected init() {}
    func readFrame(): JsonObject {
        let bytes = ArrayList<UInt8>()
        while (true) {
            if (offset == count) {
                count = readAvailable(chunk)
                offset = 0
                require(count > 0)
            }
            let b = chunk[offset]
            offset++
            if (b == 10) { return JsonValue.fromStr(String.fromUtf8(bytes.toArray())).asObject() }
            require(bytes.size < FRAME_LIMIT)
            bytes.add(b)
        }
        throw Exception("unreachable")
    }
    protected func checkedFrame(): JsonObject {
        let o = readFrame()
        let incoming = str(field(o, "protocol"), 32)
        if (protocol == "") { require(incoming == "harness/v6" || incoming == "harness/v7" || incoming == "harness/v8"); protocol = incoming }
        require(incoming == protocol)
        if (str(field(o, "type"), 32) == "cancel") {
            keys(o, ["protocol", "type", "reason"])
            str(field(o, "reason"), 512)
            throw Cancelled()
        }
        return o
    }
    protected func request(kind: String, payload: JsonObject): JsonValue {
        if (measureOnly) { require(kind == "context_preview" && serial == 0) }
        if (compactControl) { require(kind == "pause_probe" || kind == "pause_point" || kind == "finish") }
        serial++
        let id = "r${serial}"
        payload.put("protocol", text(protocol))
        payload.put("type", text(kind))
        payload.put("request_ref", text(id))
        let line = wireJson(payload)
        if (line.size > FRAME_LIMIT) { throw RemoteFailure("HARNESS_CONTEXT_LIMIT") }
        getStdOut().write(line + "\n")
        getStdOut().flush()
        let reply = checkedFrame()
        require(str(field(reply, "type"), 32) == "reply")
        require(ref(field(reply, "reply_to")) == id)
        if (reply.containsKey("error")) {
            keys(reply, ["protocol", "type", "reply_to", "error"])
            throw RemoteFailure(errorCheck(field(reply, "error")))
        }
        keys(reply, ["protocol", "type", "reply_to", "value"])
        return field(reply, "value")
    }
    protected func frameFits(kind: String, payload: JsonObject, ahead: Int64): Bool {
        payload.put("protocol", text(protocol))
        payload.put("type", text(kind))
        payload.put("request_ref", text("r${serial + ahead}"))
        return wireJson(payload).size <= FRAME_LIMIT
    }
    protected func ack(kind: String, payload: JsonObject, name: String): Unit {
        let v = request(kind, payload).asObject()
        keys(v, [name])
        require(field(v, name).asBool().getValue())
    }
}
