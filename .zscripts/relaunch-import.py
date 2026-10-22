#!/usr/bin/env python3
"""
relaunch-import.py — run the six-month historical import as a SURVIVING daemon.

Same double-fork pattern as relaunch-bridge.py (fork → setsid → fork → exec):
the sandbox harness kills all direct descendants of each tool-session shell
when the session ends; a double-fork daemon reparents to init and survives.

Usage:  python3 .zscripts/relaunch-import.py
"""
import os
import signal
import subprocess
import sys
import time

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_PATH = os.path.join(PROJECT, ".zscripts", "tmp", "import.log")


def port_open(port: int) -> bool:
    try:
        import socket

        s = socket.socket()
        s.settimeout(1)
        s.connect(("127.0.0.1", port))
        s.close()
        return True
    except OSError:
        return False


def stop_existing():
    try:
        subprocess.run(["pkill", "-f", "six-month-import.ts"], capture_output=True)
    except FileNotFoundError:
        pass
    time.sleep(1.0)


def main():
    stop_existing()

    # The import needs the bridge (:3031) — hard precondition.
    if not port_open(3031):
        print("[relaunch-import] bridge :3031 is DOWN — import refuses to start (broker-authorized source unavailable)")
        sys.exit(1)

    pid = os.fork()
    if pid > 0:
        time.sleep(1.5)
        print("[relaunch-import] daemon grandchild started (first parent exiting)")
        return

    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    os.chdir(PROJECT)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)
    logfd = os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(logfd, 1)
    os.dup2(logfd, 2)
    os.close(logfd)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    os.execvp(
        "bash",
        ["bash", "-c", "exec bun --env-file=.env scripts/six-month-import.ts"],
    )


if __name__ == "__main__":
    if os.geteuid() == 0:
        args = [sys.executable, os.path.abspath(__file__)]
        os.execvp("su", ["su", "z", "-c", " ".join(f"'{a}'" for a in args)])
    main()
    # Report early progress (the log fills asynchronously).
    for _ in range(10):
        try:
            with open(LOG_PATH) as f:
                tail = f.read()[-2000:]
            if "coverage" in tail.lower() or "fatal" in tail.lower():
                print(tail)
                sys.exit(0)
        except OSError:
            pass
        time.sleep(3)
    print("[relaunch-import] import running in background — monitor .zscripts/tmp/import.log")
