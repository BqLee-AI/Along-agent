package along_host

import std.collection.*
import std.sync.*
import std.net.*

// stdx exposes the peer on HttpRequest but not the accepted socket's local address.
class FiniteListener <: ServerSocket {
    let socket: TcpServerSocket
    let lock = Mutex()
    let connections = HashMap<String, (Int64, ?FiniteConnection)>()

    init(port: UInt16) {
        socket = TcpServerSocket(bindAt: IPSocketAddress("0.0.0.0", port))
        socket.reuseAddress = true
    }

    public prop localAddress: SocketAddress { get() { socket.localAddress } }
    public func bind(): Unit { socket.bind() }
    public func isClosed(): Bool { socket.isClosed() }
    public func close(): Unit { socket.close() }
    public func toString(): String { socket.toString() }

    public func accept(): StreamingSocket { accept(timeout: None) }
    public func accept(timeout!: ?Duration): StreamingSocket {
        let connected = socket.accept(timeout: timeout)
        if (let local: IPSocketAddress <- connected.localAddress) {
            let peer = connected.remoteAddress.toString()
            let connection = FiniteConnection(connected, local.address.toString(), { => forget(peer) })
            synchronized(lock) {
                let (count, _) = connections.get(peer).getOrDefault({ => (0, None) })
                connections[peer] = (count + 1, if (count == 0) { Some(connection) } else { None })
            }
            return connection
        }
        return connected
    }
    // stdx only exposes the peer string. Concurrent connections using the same
    // peer tuple are ambiguous on a wildcard listener and fail closed.
    func connectionFor(peer: String): ?FiniteConnection {
        synchronized(lock) {
            let (_, connection) = connections.get(peer).getOrDefault({ => (0, None) })
            return connection
        }
    }

    func forget(peer: String): Unit {
        synchronized(lock) {
            let (count, _) = connections.get(peer).getOrDefault({ => (0, None) })
            if (count <= 1) {
                connections.remove(peer)
            } else {
                connections[peer] = (count - 1, None)
            }
        }
    }
}

class FiniteConnection <: StreamingSocket {
    let socket: StreamingSocket
    let localIp: String
    let forget: () -> Unit
    let closed = AtomicBool(false)
    init(socket: StreamingSocket, localIp: String, forget: () -> Unit) {
        this.socket = socket
        this.localIp = localIp
        this.forget = forget
    }

    public prop localAddress: SocketAddress { get() { socket.localAddress } }
    public prop remoteAddress: SocketAddress { get() { socket.remoteAddress } }
    public mut prop readTimeout: ?Duration {
        get() { socket.readTimeout }
        set(value) { socket.readTimeout = value }
    }
    public mut prop writeTimeout: ?Duration {
        get() { socket.writeTimeout }
        set(value) { socket.writeTimeout = value }
    }
    public func read(buffer: Array<Byte>): Int64 { socket.read(buffer) }
    public func write(buffer: Array<Byte>): Unit { socket.write(buffer) }
    public func isClosed(): Bool { socket.isClosed() }
    public func close(): Unit {
        if (closed.compareAndSwap(false, true)) {
            forget()
            socket.close()
        }
    }
    public func toString(): String { socket.toString() }
}
