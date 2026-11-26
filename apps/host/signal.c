#define _POSIX_C_SOURCE 200809L
#include <signal.h>

static volatile sig_atomic_t stopping;

static void request_stop(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

int along_install_stop_handlers(void) {
    struct sigaction action = {0};
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, 0) == -1) return -1;
    return sigaction(SIGINT, &action, 0);
}

int along_stop_requested(void) {
    return stopping;
}
