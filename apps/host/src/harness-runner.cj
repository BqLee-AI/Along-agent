package along_host

import std.collection.*
import std.env.*
import std.fs.*
import std.process.*
import std.sync.*
import stdx.encoding.json.*

private const harnessFrameLimit: Int64 = 1048576
private const harnessCloseOnExec: Int32 = 0x80000 // Linux O_CLOEXEC
private let harnessNewline = [10u8]

foreign func pipe2(fds: CPointer<Int32>, flags: Int32): Int32
foreign func close(fd: Int32): Int32
foreign func write(fd: Int32, bytes: CPointer<Byte>, size: UIntNative): IntNative
foreign func __errno_location(): CPointer<Int32>

class HarnessRunError <: Exception {
    public let code: String

    init(code: String, message: String) {
        super(message)
        this.code = code
    }
}

private func harnessProtocol(message!: String = "harness protocol rejected"): HarnessRunError {
    return HarnessRunError("HARNESS_PROTOCOL_ERROR", message)
}

private func harnessExited(): HarnessRunError {
    return HarnessRunError("HARNESS_EXITED", "harness process exited unexpectedly")
}

private func launchHarness(args: Array<String>, input: File): SubProcess {
    let configured = getVariable("HARNESS_BINARY") ?? ""
    let binary = if (configured.isEmpty()) { "/app/harness/bin/along-harness" } else { configured }
    let library = getVariable("HARNESS_LIBRARY_PATH") ?? ""
    let environment = HashMap<String, String>()
    environment.add("LANG", "C.UTF-8")
    environment.add("LC_ALL", "C.UTF-8")
    environment.add("TZ", "UTC")
    environment.add("LD_LIBRARY_PATH", if (library.isEmpty()) { "/app/harness/lib" } else { library })
    return launch(binary, args, environment: environment, stdIn: FromFile(input), stdOut: Pipe, stdErr: Discard)
}

func runNativeCompact(operation: String, payload: String): String {
    if (operation != "assemble" && operation != "interpret") { throw harnessProtocol() }
    let directory = Directory.createTemp("/tmp")
    try {
        let path = directory.toString() + "/input"
        File.writeTo(path, unsafe { payload.rawData() })
        let input = File(path, OpenMode.Read)
        let child = try { launchHarness(["compact-${operation}/1"], input) }
        finally { input.close() }
        let done = AtomicBool(false)
        let watcher = spawn {
            while (!done.load()) {
                if (stopping()) { terminateHarness(child); break }
                sleep(25 * Duration.millisecond)
            }
        }
        var reaped = false
        try {
            let chunks = ArrayList<Array<Byte>>()
            var size: Int64 = 0
            let chunk = Array<Byte>(8192, repeat: 0)
            let outputPipe = child.stdOutPipe
            while (!stopping()) {
                let count = outputPipe.read(chunk)
                if (count <= 0) { break }
                size += count
                if (size > 8 * harnessFrameLimit) { throw harnessProtocol() }
                chunks.add(chunk.slice(0, count).clone())
            }
            let status = child.wait()
            reaped = true
            if (status != 0) { throw harnessExited() }
            let output = Array<Byte>(size, repeat: 0)
            var offset: Int64 = 0
            for (block in chunks) {
                for (index in 0..block.size) { output[offset + index] = block[index] }
                offset += block.size
            }
            return String.fromUtf8(output)
        } finally {
            done.store(true)
            watcher.get()
            if (!reaped) {
                terminateHarness(child)
                try { child.wait() } catch (_: Exception) {}
            }
        }
    } finally {
        remove(directory, recursive: true)
    }
}

// SubProcess.wait closes the SDK's stdin pipe only after exit. Own the write
// end separately so a terminal reply can be followed by EOF before waiting.
private class HarnessInput {
    let reader: Int32
    var writer: Int32

    init() {
        let fds = Array<Int32>(2, repeat: -1)
        let result = unsafe {
            let handle = acquireArrayRawData(fds)
            try { pipe2(handle.pointer, harnessCloseOnExec) }
            finally { releaseArrayRawData(handle) }
        }
        if (result != 0) { throw HarnessRunError("HARNESS_UNAVAILABLE", "harness unavailable") }
        reader = fds[0]
        writer = fds[1]
    }

    func start(): SubProcess {
        let args: Array<String> = []
        let input = File("/proc/self/fd/${reader}", OpenMode.Read)
        try {
            return launchHarness(args, input)
        } finally {
            try { input.close() } catch (_: Exception) {}
        }
    }

    func finish(): Unit {
        if (writer >= 0) {
            unsafe { close(writer) }
            writer = -1
        }
    }

    func send(frame: String): Unit {
        // The runtime blocks SIGPIPE, so broken stdin is a transport error
        // rather than a signal that can terminate the host.
        writeAll(unsafe { frame.rawData() })
        writeAll(harnessNewline)
    }

    private func writeAll(bytes: Array<Byte>): Unit {
        unsafe {
            let handle = acquireArrayRawData(bytes)
            try {
                var offset: Int64 = 0
                while (offset < bytes.size) {
                    let count = write(writer, handle.pointer + offset, UIntNative(bytes.size - offset))
                    if (count < 0 && __errno_location().read() == 4) { continue } // EINTR
                    if (count <= 0) { throw harnessExited() }
                    offset += Int64(count)
                }
            } finally {
                releaseArrayRawData(handle)
            }
        }
    }
}

private func harnessJson(line: String): JsonObject {
    try { return JsonValue.fromStr(line).asObject() }
    catch (_: Exception) { throw harnessProtocol() }
}

private func harnessFlag(reply: JsonObject, name: String): Bool {
    if (let Some(value) <- reply.get("value")) {
        if (let Some(object) <- (value as JsonObject)) {
            if (let Some(flag) <- object.get(name)) {
                if (let Some(boolean) <- (flag as JsonBool)) { return boolean.getValue() }
            }
        }
    }
    return false
}

private func harnessTerminal(request: String, reply: String, measureOnly: Bool): Bool {
    let kind = jsonText(harnessJson(request), "type")
    match (kind) {
        case "context_preview" | "suspend" | "finish" | "pause_point" | "finish_goal" => ()
        case _ => return false
    }
    let envelope = harnessJson(reply)
    if (!envelope.containsKey("value") || envelope.containsKey("error")) { return false }
    return match (kind) {
        case "context_preview" => measureOnly
        case "suspend" | "finish" => true
        case "pause_point" => harnessFlag(envelope, "paused")
        case "finish_goal" => harnessFlag(envelope, "accepted")
        case _ => false
    }
}

private func checkHarnessLine(line: String): Unit {
    if (line.isEmpty() || line.size > harnessFrameLimit || line.contains("\n")) { throw harnessProtocol() }
}

private func terminateHarness(child: SubProcess): Unit {
    // The process may already have exited, including between EOF and wait.
    try { child.terminate(force: true) } catch (_: ProcessException) {}
}

// The caller owns start/reply validation, request IDs, and the durable guard.
// Frames passed to and from exchange are UTF-8 JSON strings without their LF.
// stopping must be thread-safe (and stay true once cancellation is requested).
func runHarness(start: String, exchange: (String) -> String, stopping: () -> Bool): Unit {
    if (stopping()) { return }
    checkHarnessLine(start)
    let initial = harnessJson(start)
    let measureOnly = jsonText(initial, "protocol") == "harness/v8" &&
        initial.get("mode").getOrDefault({ => JsonString("") }).asString().getValue() == "measure_only"
    let input = HarnessInput()
    try {
        let child = try {
            input.start()
        } catch (_: Exception) {
            throw HarnessRunError("HARNESS_UNAVAILABLE", "harness unavailable")
        } finally {
            unsafe { close(input.reader) }
        }
        var reaped = false
        try {
            let done = AtomicBool(false)
            // Cancellation must be able to kill the child even when a pipe or
            // the synchronous capability callback is blocked.
            let watcher = spawn {
                while (!done.load()) {
                    if (stopping()) {
                        terminateHarness(child)
                        break
                    }
                    sleep(25 * Duration.millisecond)
                }
            }
            try {
                if (stopping()) { return }
                input.send(start)
                let output = child.stdOutPipe
                let chunk = Array<Byte>(4096, repeat: 0)
                let frame = Array<Byte>(harnessFrameLimit, repeat: 0)
                var used: Int64 = 0
                var terminal = false
                while (!stopping()) {
                    let count = try { output.read(chunk) }
                    catch (_: ProcessException) { throw harnessExited() }
                    if (stopping()) { return }
                    if (count == 0) { break }
                    if (count < 0) { throw harnessExited() }
                    if (terminal) { throw harnessProtocol(message: "harness emitted data after terminal control") }
                    for (i in 0..count) {
                        if (terminal) { throw harnessProtocol(message: "harness emitted data after terminal control") }
                        if (chunk[i] != 10) {
                            if (used == harnessFrameLimit) { throw harnessProtocol() }
                            frame[used] = chunk[i]
                            used++
                            continue
                        }
                        if (used == 0) { throw harnessProtocol() }
                        if (stopping()) { return }
                        let request = try { String.fromUtf8(frame.slice(0, used)) }
                        catch (_: IllegalArgumentException) { throw harnessProtocol() }
                        used = 0
                        let reply = exchange(request)
                        if (stopping()) { return }
                        checkHarnessLine(reply)
                        terminal = harnessTerminal(request, reply, measureOnly)
                        input.send(reply)
                        if (terminal) { input.finish() }
                    }
                }
                if (stopping()) { return }
                if (used != 0) { throw harnessProtocol(message: "harness ended with an incomplete frame") }
                input.finish()
                let status = try { child.wait() }
                catch (_: ProcessException) { throw harnessExited() }
                reaped = true
                if (stopping()) { return }
                if (status != 0) { throw harnessExited() }
                if (!terminal) { throw harnessProtocol(message: "harness ended without terminal control") }
            } catch (e: Exception) {
                if (!stopping()) { throw e }
            } finally {
                done.store(true)
                try { watcher.get() } catch (_: Exception) {}
            }
        } finally {
            if (!reaped) {
                terminateHarness(child)
                try { child.wait() } catch (_: Exception) {}
            }
        }
    } finally {
        input.finish()
    }
}
