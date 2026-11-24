# SPDX-License-Identifier: MIT
"""The house's copy of Kohl's repos, to read (BABELR_MCP_REPOS, e.g. ~/house/repos).

One clean clone per repo, kept fresh by the house (house/tools/house_repos.py), so a
guest can read the whole codebase from one place. Read-only: nothing here writes.
Only files git tracks can be read, so nothing that was never pushed is in reach, and
secret-looking names are refused even if someone committed one."""
from __future__ import annotations

import fnmatch
import json
import subprocess
from pathlib import Path

DENIED = (".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
          "id_ecdsa*", "*secret*", "credentials*.json", "auth.json", "*.token")
MAX_LINES = 600
MAX_HITS = 200
MAX_FILES = 1000


class RepoError(Exception):
    pass


def _denied(rel: str) -> bool:
    return any(fnmatch.fnmatch(part.lower(), pat) for part in Path(rel).parts for pat in DENIED)


class Repos:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser()

    def _index(self) -> dict:
        try:
            return json.loads((self.root / ".index.json").read_text())
        except (OSError, ValueError):
            return {"repos": []}

    def _repo(self, name: str) -> Path:
        names = {r["name"].lower(): r["name"] for r in self._index()["repos"]}
        real = names.get((name or "").strip().lower())
        if not real:
            raise RepoError(f"No repo called {name!r}. list_repos shows what's here.")
        return self.root / real

    def _git(self, repo: Path, *args: str) -> str:
        r = subprocess.run(["git", "-c", "safe.directory=*", "-C", str(repo), *args],
                           capture_output=True, text=True, timeout=30)
        if r.returncode not in (0, 1):  # grep exits 1 for "no matches"
            raise RepoError(r.stderr.strip() or "git failed")
        return r.stdout

    def _tracked(self, repo: Path, path: str = "") -> list[str]:
        args = ["ls-files", "-z"] + (["--", path.strip("/")] if path.strip("/") else [])
        return [f for f in self._git(repo, *args).split("\0") if f and not _denied(f)]

    def list(self) -> dict:
        idx = self._index()
        return {"synced": idx.get("synced"),
                "repos": [{"name": r["name"], "description": r.get("description", ""),
                           "branch": r.get("branch"), "last_push": r.get("pushed")} for r in idx["repos"]],
                "note": "Clean copies of what's pushed to GitHub, refreshed every 15 minutes. Read-only."}

    def files(self, repo: str, path: str = "", pattern: str = "") -> dict:
        r = self._repo(repo)
        fs = self._tracked(r, path)
        if pattern:
            fs = [f for f in fs if fnmatch.fnmatch(f, pattern) or fnmatch.fnmatch(Path(f).name, pattern)]
        out = {"repo": r.name, "count": len(fs), "files": fs[:MAX_FILES]}
        if len(fs) > MAX_FILES:
            out["cut"] = f"Showing {MAX_FILES} of {len(fs)}: narrow it with path or pattern."
        return out

    def read(self, repo: str, path: str, start: int = 1, lines: int = 400) -> dict:
        r = self._repo(repo)
        rel = path.strip().lstrip("/")
        if _denied(rel):
            raise RepoError(f"{rel} looks like a secret, so it can't be read.")
        if rel not in set(self._tracked(r, rel)):
            raise RepoError(f"{rel} isn't a file in {r.name}. repo_files lists them.")
        data = (r / rel).read_bytes()
        if b"\0" in data[:8000]:
            return {"repo": r.name, "path": rel, "binary": True, "bytes": len(data)}
        text = data.decode("utf-8", errors="replace").splitlines()
        start = max(1, int(start))
        n = max(1, min(int(lines), MAX_LINES))
        chunk = text[start - 1:start - 1 + n]
        out = {"repo": r.name, "path": rel, "start": start, "total_lines": len(text),
               "text": "\n".join(f"{i}\t{line}" for i, line in enumerate(chunk, start))}
        if start - 1 + n < len(text):
            out["more"] = f"Lines {start + len(chunk)}–{len(text)} not shown: read again with start."
        return out

    def search(self, query: str, repo: str = "", path: str = "", regex: bool = False) -> dict:
        if not query:
            raise RepoError("Give something to search for.")
        targets = [self._repo(repo)] if repo else [self.root / x["name"] for x in self._index()["repos"]]
        hits: list[dict] = []
        total = 0
        for r in targets:
            args = ["grep", "-n", "-I", "--no-color", "-i"] + ([] if regex else ["-F"]) + ["-e", query]
            if path:
                args += ["--", path.strip("/")]
            for line in self._git(r, *args).splitlines():
                f, _, rest = line.partition(":")
                no, _, text = rest.partition(":")
                if _denied(f):
                    continue
                total += 1
                if len(hits) < MAX_HITS:
                    hits.append({"repo": r.name, "path": f, "line": int(no) if no.isdigit() else no,
                                 "text": text.strip()[:300]})
        out = {"query": query, "count": total, "hits": hits}
        if total > MAX_HITS:
            out["cut"] = f"Showing {MAX_HITS} of {total}: narrow it with repo or path."
        return out

    def log(self, repo: str, n: int = 20, path: str = "") -> dict:
        r = self._repo(repo)
        args = ["log", f"-{max(1, min(int(n), 100))}", "--format=%h%x09%ad%x09%an%x09%s", "--date=short"]
        if path:
            args += ["--", path.strip("/")]
        commits = []
        for line in self._git(r, *args).splitlines():
            h, d, a, s = (line.split("\t") + ["", "", "", ""])[:4]
            commits.append({"commit": h, "date": d, "author": a, "subject": s})
        return {"repo": r.name, "commits": commits}
