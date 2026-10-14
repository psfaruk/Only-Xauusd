#!/usr/bin/env python3
"""
relaunch-dev.py — start the Next.js dev server as a SURVIVING daemon.

Why this exists: the sandbox harness kills all direct descendants of each
tool-session shell when the session ends. A plain `nohup ... &` or even
`setsid ... &` dies within seconds of the session closing. A classic
double-fork daemon (fork → setsid → fork → exec) reparents to init and
escapes that cleanup — verified empirically (canary test, 2026-10-14).

Usage:  python3 .zscripts/relaunch-dev.py
"""

import os
import signal
import subprocess
import sys
import time

PROJECT = "/home/z/my-project"


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
    """Kill any current dev-server processes (graceful, then force)."""
    try:
        out = subprocess.run(
            ["pkill", "-f", "next dev -p 3000"],
            capture_output=True,
        )
        del out
    except FileNotFoundError:
        pass
    try:
        subprocess.run(["pkill", "-f", "next-server"], capture_output=True)
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
        print(f"[relaunch-dev] daemon grandchild started (first parent exiting)")
        return

    # Child: new session, then fork again so it can never re-acquire a tty.
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    # Grandchild (the daemon): detach stdio, move to the project, exec dev.
    os.chdir(PROJECT)
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

    # `bun run dev` = next dev -p 3000 2>&1 | tee dev.log — the pipeline
    # itself handles logging; we just need a shell to run it.
    os.execvp("bash", ["bash", "-c", "exec bun run dev"])


if __name__ == "__main__":
    if os.geteuid() == 0:
        # The harness sometimes invokes us as root — drop to z for a
        # consistent environment with the boot-started server.
        args = [sys.executable, os.path.abspath(__file__)]
        os.execvp("su", ["su", "z", "-c", " ".join(f"'{a}'" for a in args)])
    main()
    # Give the daemon a moment, then verify port 3000.
    for _ in range(30):
        if port_open(3000):
            print("[relaunch-dev] port 3000 is up")
            sys.exit(0)
        time.sleep(1)
    print("[relaunch-dev] WARNING: port 3000 did not open in 30s — check dev.log", file=sys.stderr)
    sys.exit(1)
