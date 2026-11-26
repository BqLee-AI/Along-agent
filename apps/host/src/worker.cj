package along_host

import std.time.MonoTime

func runWorker(call: (String, String) -> Bool, workerId: String, stopping: () -> Bool): Unit {
    // Match OUTBOX_POLL_INTERVAL_MS in scheduler-core, including the first delay.
    let interval = 30 * Duration.second
    let stopPollInterval = 50 * Duration.millisecond
    let phases = ["cancel", "schedule", "claim", "send", "ack", "missed"]
    var due = MonoTime.now() + interval

    while (!stopping()) {
        let now = MonoTime.now()
        if (now < due) {
            sleep(min(due - now, stopPollInterval))
            continue
        }
        for (phase in phases) {
            let success = try {
                call(phase, workerId)
            } catch (_: Exception) {
                false
            }
            if (!success) { eprintln("[worker] phase failed: ${phase}") }
        }
        // A slow tick skips the elapsed slots; it never queues catch-up work.
        let finished = MonoTime.now()
        due = due + interval
        while (due <= finished) { due = due + interval }
    }
}
