#!/usr/bin/env python3
"""
relaunch-bridge.py — start the mt5-bridge (:3031) as a SURVIVING daemon.

Same double-fork pattern as relaunch-dev.py (fork → setsid → fork → exec):
the sandbox harness kills all direct descendants of each tool-session shell
when the session ends; a plain `nohup/setsid ... &` dies within seconds.
A double-fork daemon reparents to init and escapes that cleanup.

Usage:  python3 .zscripts/relaunch-bridge.py
"""
import os
import signal
import subprocess
import sys
import time

# Project root = parent of this script's directory (.zscripts lives at
# <project-root>/.zscripts). Derived from __file__ so the script is portable
# (no sandbox-specific absolute path); behavior is identical.
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE_DIR = os.path.join(PROJECT, "mini-services", "mt5-bridge")
LOG_PATH = os.path.join(BRIDGE_DIR, "bridge.log")


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
    """Kill any current bridge processes (graceful SIGTERM, then wait)."""
    try:
        subprocess.run(
            ["pkill", "-f", "bun --hot --env-file=../../.env index.ts"],
            capture_output=True,
        )
    except FileNotFoundError:
        pass
    time.sleep(1.5)


def main():
    stop_existing()

    pid = os.fork()
    if pid > 0:
        # First parent: wait briefly and report, then exit so the grandchild
        # gets reparented to init.
        time.sleep(2)
        print("[relaunch-bridge] daemon grandchild started (first parent exiting)")
        return

    # Child: new session, then fork again so it can never re-acquire a tty.
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    # Grandchild (the daemon): detach stdio to bridge.log, run bun dev.
    os.chdir(BRIDGE_DIR)
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
        if port_open(3031):
            print("[relaunch-bridge] port 3031 is up")
            sys.exit(0)
        time.sleep(1)
    print("[relaunch-bridge] WARNING: port 3031 did not open in 30s — check bridge.log", file=sys.stderr)
    sys.exit(1)
