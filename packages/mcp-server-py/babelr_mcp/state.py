# SPDX-License-Identifier: MIT
"""What the connector keeps between restarts, in one JSON file (mode 600):
registered OAuth clients, issued tokens (by hash, never the token itself), and,
per DM, the newest message already handed to the client, so `inbox` only
returns what's new."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class State:
    def __init__(self, path: str | Path):
        self.path = Path(path).expanduser()
        self._lock = threading.Lock()
        try:
            self.data: dict[str, Any] = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.data = {}
        for k in ("clients", "access", "refresh", "seen"):
            self.data.setdefault(k, {})

    def save(self) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.data, f, indent=1)
            os.replace(tmp, self.path)

    def prune(self) -> None:
        now = time.time()
        for k in ("access", "refresh"):
            self.data[k] = {h: t for h, t in self.data[k].items()
                            if not t.get("expires_at") or t["expires_at"] > now}
