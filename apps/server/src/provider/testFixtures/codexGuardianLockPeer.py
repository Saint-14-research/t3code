import fcntl
import os
import sys
import time


lock_path = sys.argv[1]
try_once = len(sys.argv) > 2 and sys.argv[2] == "--try-once"

with open(lock_path, "a+", encoding="utf-8") as lock_file:
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("LOCK_BLOCKED", flush=True)
        raise SystemExit(2)

    if try_once:
        print("LOCK_ACQUIRED", flush=True)
    else:
        print(f"LOCK_READY {os.getpid()}", flush=True)
        while True:
            time.sleep(60)
