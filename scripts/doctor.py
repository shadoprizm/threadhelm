#!/usr/bin/env python3
"""Read-only setup diagnostics for the local control workspace.

The doctor reports paths and availability only. It never reads credential files,
prints secret values, edits configuration, or starts a service.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE_LOCATIONS = {
    "Codex": (".codex/sessions",),
    "Claude Code": (".claude/projects", ".claude/sessions"),
    "Hermes": (".hermes", ".config/hermes"),
    "OpenClaw": (".openclaw", ".config/openclaw"),
}


def result(status: str, name: str, detail: str) -> dict[str, str]:
    return {"status": status, "name": name, "detail": detail}


def command_version(command: str, minimum: tuple[int, int] | None = None) -> dict[str, str]:
    path = shutil.which(command)
    if not path:
        return result("fail", command, "not found on PATH")
    try:
        completed = subprocess.run(
            [path, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        version = (completed.stdout or completed.stderr).strip().splitlines()[0]
    except (OSError, subprocess.TimeoutExpired) as error:
        return result("warn", command, f"found at {path}, version check failed: {error}")
    if minimum:
        match = re.search(r"(\d+)\.(\d+)", version)
        if not match or tuple(map(int, match.groups())) < minimum:
            return result("fail", command, f"{version}; requires {minimum[0]}.{minimum[1]}+")
    return result("pass", command, f"{version} ({path})")


def configured_path(value: Any) -> pathlib.Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return pathlib.Path(os.path.expandvars(value)).expanduser()


def private_file_check(name: str, path: pathlib.Path) -> dict[str, str]:
    if not path.is_file():
        return result("warn", name, "credential file is not present on this machine")
    stat = path.stat()
    if stat.st_mode & 0o077:
        return result("fail", name, f"permissions must be 0600: {path}")
    if stat.st_size == 0:
        return result("fail", name, f"credential file is empty: {path}")
    return result("pass", name, "credential file exists with private permissions (contents not read)")


def loopback_url_check(name: str, value: Any) -> dict[str, str]:
    if not isinstance(value, str) or not value.strip():
        return result("fail", name, "URL is missing")
    try:
        host = (urllib.parse.urlparse(value).hostname or "").lower()
    except ValueError as error:
        return result("fail", name, f"invalid URL: {error}")
    if host not in {"localhost", "127.0.0.1", "::1"} and not host.startswith("127."):
        return result("fail", name, "endpoint must be loopback-only")
    return result("pass", name, f"loopback endpoint: {value}")


def inspect_config(path: pathlib.Path) -> tuple[dict[str, Any] | None, list[dict[str, str]]]:
    if not path.is_file():
        return None, [result("fail", "configuration", f"missing: {path}")]
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, [result("fail", "configuration", f"cannot parse {path}: {error}")]
    if not isinstance(config, dict):
        return None, [result("fail", "configuration", "top-level JSON value must be an object")]
    checks = [result("pass", "configuration", f"valid JSON: {path}")]
    hosts = config.get("hosts")
    sources = config.get("sources", [])
    if not isinstance(hosts, list) or not hosts:
        checks.append(result("fail", "configured hosts", "add at least one host"))
    else:
        checks.append(result("pass", "configured hosts", f"{len(hosts)} host(s) declared"))
    if not isinstance(sources, list):
        checks.append(result("fail", "configured sources", "sources must be a list"))
    else:
        adapters = sorted(
            {str(source.get("adapter")) for source in sources if isinstance(source, dict) and source.get("adapter")}
        )
        checks.append(
            result(
                "pass" if adapters else "warn",
                "configured sources",
                ", ".join(adapters) if adapters else "no optional sources declared",
            )
        )
    placeholder = json.dumps(config)
    if "/Users/you/" in placeholder or "/home/you/" in placeholder or "your-existing-ssh-host" in placeholder:
        checks.append(result("warn", "configuration placeholders", "example paths or hosts still need replacement"))
    return config, checks


def source_discovery(home: pathlib.Path) -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    for source, relative_paths in SOURCE_LOCATIONS.items():
        found = [home / relative for relative in relative_paths if (home / relative).exists()]
        checks.append(
            result(
                "pass" if found else "warn",
                f"{source} source",
                ", ".join(str(path) for path in found) if found else "no standard local data directory found",
            )
        )
    return checks


def local_config_paths(config: dict[str, Any] | None) -> list[dict[str, str]]:
    if not config:
        return []
    checks: list[dict[str, str]] = []
    hosts = [host for host in config.get("hosts", []) if isinstance(host, dict)]
    remote_host_ids = {host.get("id") for host in hosts if host.get("ssh")}
    for host in hosts:
        if not isinstance(host, dict) or host.get("ssh"):
            continue
        binary = configured_path(host.get("codex"))
        if binary:
            checks.append(
                result(
                    "pass" if binary.is_file() else "warn",
                    f"Codex executable for {host.get('name') or host.get('id') or 'local host'}",
                    f"found: {binary}" if binary.is_file() else f"not found: {binary}",
                )
            )
    for source in config.get("sources", []):
        if not isinstance(source, dict):
            continue
        label = str(source.get("name") or source.get("adapter") or "source")
        if source.get("adapter") in {"hermes", "openclaw", "openwebui"}:
            checks.append(loopback_url_check(f"{label} baseUrl", source.get("baseUrl")))
        if source.get("hostId") in remote_host_ids:
            continue
        for key in ("projectsDir", "sessionsDir"):
            directory = configured_path(source.get(key))
            if directory:
                checks.append(
                    result(
                        "pass" if directory.is_dir() else "warn",
                        f"{source.get('name') or source.get('adapter')} {key}",
                        f"found: {directory}" if directory.is_dir() else f"not found: {directory}",
                    )
                )
        for key in ("tokenFile", "deviceFile"):
            secret_file = configured_path(source.get(key))
            if secret_file:
                checks.append(private_file_check(f"{label} {key}", secret_file))
    runtime = config.get("runtime")
    if isinstance(runtime, dict):
        checks.append(loopback_url_check("runtime baseUrl", runtime.get("baseUrl")))
        for index, value in enumerate(runtime.get("loadedModelUrls", [])):
            checks.append(loopback_url_check(f"runtime loadedModelUrls[{index}]", value))
        token_file = configured_path(runtime.get("tokenFile"))
        if token_file:
            checks.append(private_file_check("runtime tokenFile", token_file))
    return checks


def health_check(url: str) -> dict[str, str]:
    try:
        with urllib.request.urlopen(url, timeout=4) as response:
            return result("pass", "service health", f"HTTP {response.status} from {url}")
    except urllib.error.HTTPError as error:
        status = "warn" if error.code in {401, 403} else "fail"
        return result(status, "service health", f"HTTP {error.code} from {url}")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return result("warn", "service health", f"unreachable at {url}: {error}")


def run(config_path: pathlib.Path, health_url: str | None, skip_health: bool) -> list[dict[str, str]]:
    checks = [
        result("pass", "python", f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"),
        command_version("node", (22, 19)),
        command_version("npm"),
        command_version("git"),
    ]
    config, config_checks = inspect_config(config_path)
    checks.extend(config_checks)
    checks.extend(local_config_paths(config))
    checks.extend(source_discovery(pathlib.Path.home()))
    if not skip_health:
        port = config.get("port", 4318) if config else 4318
        checks.append(health_check(health_url or f"http://127.0.0.1:{port}/healthz"))
    return checks


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path(os.environ.get("THREADHELM_CONFIG") or os.environ.get("ASTRA_CONFIG") or ROOT / "data/config.json"),
        help="configuration file to validate",
    )
    parser.add_argument("--url", help="health endpoint to check")
    parser.add_argument("--skip-health", action="store_true", help="skip the local HTTP health check")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    checks = run(args.config.expanduser(), args.url, args.skip_health)
    if args.json:
        print(json.dumps({"checks": checks}, indent=2))
    else:
        width = max(len(check["status"]) for check in checks)
        for check in checks:
            print(f"{check['status'].upper():<{width}}  {check['name']}: {check['detail']}")
        print("\nNo credential contents were read.")
    return 1 if any(check["status"] == "fail" for check in checks) else 0


if __name__ == "__main__":
    raise SystemExit(main())
