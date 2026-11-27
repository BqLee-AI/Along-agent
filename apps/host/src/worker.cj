package along_host

import std.time.MonoTime

func runWorker(call: (String, String) -> Bool, workerId: String, stopping: () -> Bool): Unit {
    let due = MonoTime.now() + 30 * Duration.second
    let mail = spawn { runWorkerPhases(call, workerId, stopping, ["identity-mail"], due) }
    let news = spawn { runWorkerPhases(call, workerId, stopping, ["news"], due) }
    runWorkerPhases(call, workerId, stopping, ["cancel", "schedule", "claim", "send", "ack", "missed"], due)
    mail.get()
    news.get()
}

func runWorkerPhases(call: (String, String) -> Bool, workerId: String, stopping: () -> Bool,
                     phases: Array<String>, firstDue: MonoTime): Unit {
    // Match OUTBOX_POLL_INTERVAL_MS in scheduler-core, including the first delay.
    let interval = 30 * Duration.second
    let stopPollInterval = 50 * Duration.millisecond
    var due = firstDue

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
