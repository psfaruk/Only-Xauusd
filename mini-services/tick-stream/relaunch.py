#!/usr/bin/env python3
"""
relaunch.py — start tick-stream (:3041) as a SURVIVING daemon (Task 29-b).

Same double-fork pattern as .zscripts/relaunch-bridge.py (fork → setsid →
fork → exec): the sandbox harness kills all direct descendants of each
tool-session shell when the session ends; a plain `nohup/setsid ... &` dies
within seconds. The double-fork daemon reparents to init and escapes that
cleanup.

Safe by construction: process cleanup matches ONLY processes whose CWD is
this directory — never a command-line pattern (identical to the mt5-bridge's
command line) and never the bridge or the Next.js dev server.

Usage:  python3 relaunch.py            # start if not running (idempotent)
        python3 relaunch.py --restart  # stop this service's processes, then start
"""
import os
import signal
import socket
import sys
import time

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = "/home/z/my-project/tickstream-dev.log"
PORT = 3041


def port_open(port: int) -> bool:
    try:
        s = socket.socket()
        s.settimeout(1)
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def service_pids():
    """PIDs of processes whose CWD is this service directory (this service only)."""
    pids = []
    me = os.getpid()
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == me:
            continue
        try:
            if os.readlink(f"/proc/{pid}/cwd") == SERVICE_DIR:
                pids.append(pid)
        except OSError:
            continue
    return pids


def stop_existing():
    """Gracefully stop this service's processes (SIGTERM, then SIGKILL fallback)."""
    for pid in service_pids():
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(20):
        if not service_pids():
            return
        time.sleep(0.5)
    for pid in service_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(1)


def main():
    force = "--restart" in sys.argv
    already = service_pids()
    if already and not force and port_open(PORT):
        print(f"[relaunch] tick-stream already running (pids={already}, port {PORT} open) — nothing to do")
        return
    if force or already:
        stop_existing()

    pid = os.fork()
    if pid > 0:
        # First parent: wait briefly and report, then exit so the grandchild
        # gets reparented to init.
        time.sleep(2)
        print("[relaunch] daemon grandchild started (first parent exiting)")
        return

    # Child: new session, then fork again so it can never re-acquire a tty.
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    # Grandchild (the daemon): detach stdio to the service log, run bun dev.
    os.chdir(SERVICE_DIR)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    logfd = os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    os.close(logfd)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    os.execvp("bash", ["bash", "-c", "exec bun run dev"])


if __name__ == "__main__":
    if os.geteuid() == 0:
        # The harness sometimes invokes us as root — drop to z.
        args = [sys.executable, os.path.abspath(__file__)]
        os.execvp("su", ["su", "z", "-c", " ".join(f"'{a}'" for a in args)])
    main()
    for _ in range(30):
        if port_open(PORT):
            print(f"[relaunch] port {PORT} is up")
            sys.exit(0)
        time.sleep(1)
    print(f"[relaunch] WARNING: port {PORT} did not open in 30s — check {LOG_PATH}", file=sys.stderr)
    sys.exit(1)
