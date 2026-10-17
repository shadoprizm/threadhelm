#!/usr/bin/env python3
"""Repository-native growth operations with human approval at publication boundaries.

This script reads the campaign files in growth/. Read-only commands are the default.
It never posts to communities, sends direct messages, or emails candidates.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
GROWTH = ROOT / "growth"
CONFIG_PATH = GROWTH / "config.json"
SCHEDULE_PATH = GROWTH / "schedule.json"
QUEUE_PATH = GROWTH / "content-queue.json"
TEMPLATES = GROWTH / "templates"


def load_json(path: pathlib.Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must contain a JSON object")
    return data


def load_campaign() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    return load_json(CONFIG_PATH), load_json(SCHEDULE_PATH), load_json(QUEUE_PATH)


def parse_date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"expected an ISO date (YYYY-MM-DD), got {value!r}") from error


def today(value: str | None) -> dt.date:
    return parse_date(value) if value else dt.datetime.now(dt.timezone.utc).date()


def campaign_day(config: dict[str, Any], on: dt.date) -> int:
    return (on - campaign_start(config)).days + 1


def campaign_week(day: int) -> int:
    return 0 if day < 1 else ((day - 1) // 7) + 1


def event_date(config: dict[str, Any], day: int) -> dt.date:
    return campaign_start(config) + dt.timedelta(days=day - 1)


def markdown_escape(value: Any) -> str:
    return str(value or "").replace("|", "\\|").replace("\n", " ").strip()


def campaign_state(config: dict[str, Any]) -> str:
    return str(config.get("campaign_state", "frozen"))


def campaign_start(config: dict[str, Any]) -> dt.date:
    value = config.get("launch_date") or config["start_date"]
    return parse_date(str(value))


def validate() -> list[str]:
    errors: list[str] = []
    try:
        config, schedule, queue = load_campaign()
    except (OSError, json.JSONDecodeError, ValueError) as error:
        return [str(error)]

    if config.get("schema_version") != 1:
        errors.append("growth/config.json schema_version must be 1")
    if schedule.get("schema_version") != 1:
        errors.append("growth/schedule.json schema_version must be 1")
    if queue.get("schema_version") != 1:
        errors.append("growth/content-queue.json schema_version must be 1")

    state = campaign_state(config)
    if state not in {"frozen", "readiness", "active", "complete"}:
        errors.append("campaign_state must be frozen, readiness, active, or complete")
    approved_name = config.get("approved_product_name")
    if state == "active" and (not isinstance(approved_name, str) or not approved_name.strip()):
        errors.append("an active campaign requires approved_product_name")
    if state == "active" and approved_name != config.get("product_name"):
        errors.append("approved_product_name must exactly match product_name")
    approved_repository = config.get("approved_repository")
    if state == "active" and approved_repository != config.get("repository"):
        errors.append("approved_repository must exactly match repository")
    if state == "active" and not config.get("launch_date"):
        errors.append("an active campaign requires launch_date")
    if config.get("launch_date"):
        try:
            parse_date(str(config["launch_date"]))
        except ValueError as error:
            errors.append(f"invalid launch_date: {error}")

    try:
        parse_date(str(config["start_date"]))
    except (KeyError, ValueError) as error:
        errors.append(f"invalid start_date: {error}")
    duration = config.get("duration_days")
    if not isinstance(duration, int) or duration < 1:
        errors.append("duration_days must be a positive integer")
        duration = 90

    seen_events: set[str] = set()
    allowed_automation = {"metrics", "reminder", "content-draft"}
    for index, event in enumerate(schedule.get("events", [])):
        prefix = f"schedule event {index + 1}"
        identifier = event.get("id")
        if not identifier or identifier in seen_events:
            errors.append(f"{prefix} has a missing or duplicate id")
        seen_events.add(str(identifier))
        day = event.get("day")
        if not isinstance(day, int) or not 1 <= day <= duration:
            errors.append(f"{prefix} day must be between 1 and {duration}")
        if event.get("automation") not in allowed_automation:
            errors.append(f"{prefix} has an unknown automation value")
        if event.get("kind") in {"launch", "distribution", "content", "proof", "release", "recruitment", "community"} and not event.get("human_gate"):
            errors.append(f"{prefix} publishes or contacts people and must have human_gate=true")

    seen_content: set[str] = set()
    for index, item in enumerate(queue.get("items", [])):
        prefix = f"content item {index + 1}"
        identifier = item.get("id")
        if not identifier or identifier in seen_content:
            errors.append(f"{prefix} has a missing or duplicate id")
        seen_content.add(str(identifier))
        day = item.get("day")
        if not isinstance(day, int) or not 1 <= day <= duration:
            errors.append(f"{prefix} day must be between 1 and {duration}")
        template = TEMPLATES / str(item.get("template", ""))
        if not template.is_file():
            errors.append(f"{prefix} references missing template {template.name!r}")
        if item.get("status") not in {"planned", "blocked-on-consent", "blocked-on-product", "drafted", "approved", "published"}:
            errors.append(f"{prefix} has an unsupported status")

    target_days = [target.get("day") for target in config.get("star_targets", [])]
    if target_days != sorted(target_days) or any(not isinstance(day, int) or day > duration for day in target_days):
        errors.append("star_targets must use sorted days within the campaign")
    return errors


def require_valid() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    errors = validate()
    if errors:
        raise ValueError("campaign validation failed:\n- " + "\n- ".join(errors))
    return load_campaign()


def render_calendar(on: dt.date | None = None) -> str:
    config, schedule, _ = require_valid()
    if campaign_state(config) != "active":
        return textwrap.dedent(
            f"""\
            # Growth calendar suspended

            Campaign state: **{campaign_state(config).upper()}**.

            A dated launch calendar will be generated only after the product name, repository, and launch date are approved.
            """
        )
    lines = [
        f"# {config['campaign_name']}: 90-day calendar",
        "",
        f"Start: {campaign_start(config).isoformat()}  ",
        f"End: {event_date(config, config['duration_days']).isoformat()}  ",
        f"North star: {config['north_star']}",
        "",
        "| Date | Day | Phase | Deliverable | Gate |",
        "|---|---:|---|---|---|",
    ]
    phases = schedule["phases"]
    for event in sorted(schedule["events"], key=lambda item: (item["day"], item["id"])):
        phase = next(item["name"] for item in phases if item["start_day"] <= event["day"] <= item["end_day"])
        marker = " ← today" if on and event_date(config, event["day"]) == on else ""
        gate = "Human approval" if event["human_gate"] else "Automated/read-only"
        lines.append(
            f"| {event_date(config, event['day']).isoformat()}{marker} | {event['day']} | "
            f"{markdown_escape(phase)} | {markdown_escape(event['deliverable'])} | {gate} |"
        )
    return "\n".join(lines) + "\n"


def target_for_day(config: dict[str, Any], day: int) -> tuple[int, int]:
    targets = config["star_targets"]
    for target in targets:
        if day <= target["day"]:
            return target["day"], target["stars"]
    final = targets[-1]
    return final["day"], final["stars"]


def relevant_events(schedule: dict[str, Any], start_day: int, end_day: int) -> list[dict[str, Any]]:
    return [
        event
        for event in sorted(schedule["events"], key=lambda item: (item["day"], item["id"]))
        if start_day <= event["day"] <= end_day
    ]


def due_content(queue: dict[str, Any], start_day: int, end_day: int) -> list[dict[str, Any]]:
    return [
        item
        for item in sorted(queue["items"], key=lambda entry: (entry["day"], entry["id"]))
        if start_day <= item["day"] <= end_day and item["status"] != "published"
    ]


def weekly_brief(on: dt.date) -> str:
    config, schedule, queue = require_valid()
    if campaign_state(config) != "active":
        state = campaign_state(config)
        name_step = (
            "Approve an exact product name and record it as `approved_product_name`."
            if state == "frozen"
            else "Confirm the approved campaign identity before activation."
        )
        return textwrap.dedent(
            f"""\
            # Growth readiness brief

            Date: {on.isoformat()} · campaign state: **{state.upper()}**

            - [ ] {name_step}
            - [ ] Reconcile public main, the deployed commit, and every active checkout.
            - [ ] Verify a clean install and the five-minute sample workspace journey.
            - [ ] Set a new `launch_date`, then change `campaign_state` to `active`.

            No launch drafts, star deadlines, releases, or outreach are due while the brand gate is unresolved.
            """
        )
    day = campaign_day(config, on)
    week = campaign_week(day)
    if day < 1:
        start_day, end_day = 1, min(7, config["duration_days"])
        status = f"Pre-launch: campaign starts in {1 - day} day(s)."
    else:
        start_day = ((day - 1) // 7) * 7 + 1
        end_day = min(start_day + 6, config["duration_days"])
        status = f"Campaign day {day}, week {week}."
    target_day, target_stars = target_for_day(config, max(day, 1))
    events = relevant_events(schedule, start_day, end_day)
    content = due_content(queue, start_day, end_day)
    lines = [
        f"# Growth brief: week {week or 'pre-launch'}",
        "",
        status,
        f"Next star checkpoint: **{target_stars} stars by day {target_day}**.",
        "",
        "## Outcomes due",
        "",
    ]
    if events:
        for event in events:
            gate = "human approval required" if event["human_gate"] else "safe to automate"
            lines.append(f"- [ ] Day {event['day']}: {event['deliverable']} _({gate})_")
    else:
        lines.append("- No scheduled milestone in this window.")
    lines.extend(["", "## Content queue", ""])
    if content:
        for item in content:
            lines.append(f"- [ ] `{item['id']}` → {item['channel']}: {item['angle']} ({item['status']})")
    else:
        lines.append("- No draft is scheduled in this window.")
    lines.extend(
        [
            "",
            "## Funnel review",
            "",
            "- [ ] Count applications, qualified operators, successful installs, weekly-active operators, and approved case studies.",
            "- [ ] Reply to opted-in applicants within two working days.",
            "- [ ] Convert repeated support friction into a documented fix or scoped contributor issue.",
            "- [ ] Compare visitors → demo starts → successful installs; do not optimize stars in isolation.",
            "",
            "## Publication gate",
            "",
            "No generated draft may be posted automatically. A maintainer must verify claims, destination rules, timing, links, screenshots, and consent before publication.",
        ]
    )
    return "\n".join(lines) + "\n"


def render_item(config: dict[str, Any], item: dict[str, Any]) -> str:
    if campaign_state(config) != "active":
        raise ValueError("content rendering requires campaign_state=active")
    template_path = TEMPLATES / item["template"]
    content = template_path.read_text(encoding="utf-8")
    values = {
        "angle": item["angle"],
        "channel": item["channel"],
        "cta": item["cta"],
        "product_name": config["product_name"],
        "repository_url": config["repository_url"],
    }
    for key, value in values.items():
        content = content.replace("{" + key + "}", str(value))
    header = textwrap.dedent(
        f"""\
        > **Draft only — human approval required**
        >
        > Queue ID: `{item['id']}` · channel: `{item['channel']}` · campaign day: {item['day']} · status: `{item['status']}`
        > This file was generated locally. Automation must never submit it to the destination.

        """
    )
    return header + content.rstrip() + "\n"


def content_drafts(on: dt.date, item_id: str | None, window: int) -> str:
    config, _, queue = require_valid()
    if campaign_state(config) != "active":
        return textwrap.dedent(
            f"""\
            # Content drafts blocked

            Campaign state: **{campaign_state(config).upper()}**.

            Draft generation is disabled until an exact product name and launch date are approved and `campaign_state` is `active`.
            """
        )
    if item_id:
        items = [item for item in queue["items"] if item["id"] == item_id]
        if not items:
            raise ValueError(f"unknown content item {item_id!r}")
    else:
        day = campaign_day(config, on)
        items = due_content(queue, day, day + window - 1)
    if not items:
        return "# Content drafts\n\nNo unpublished content is due in this window.\n"
    sections = [render_item(config, item) for item in items]
    return ("\n\n---\n\n").join(sections)


def github_token() -> str | None:
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        return token
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def github_get(path: str, token: str | None) -> Any:
    request = urllib.request.Request(
        "https://api.github.com" + path,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "repository-growth-ops",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def optional_github_get(path: str, token: str | None) -> tuple[Any | None, str | None]:
    try:
        return github_get(path, token), None
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        return None, f"{type(error).__name__}: {getattr(error, 'reason', str(error))}"


def metrics_report(on: dt.date) -> str:
    config, _, _ = require_valid()
    token = github_token()
    repo = config["repository"]
    repo_data, repo_error = optional_github_get(f"/repos/{repo}", token)
    traffic_views, views_error = optional_github_get(f"/repos/{repo}/traffic/views?per=day", token)
    traffic_clones, clones_error = optional_github_get(f"/repos/{repo}/traffic/clones?per=day", token)
    contributors, contributor_error = optional_github_get(f"/repos/{repo}/contributors?per_page=100&anon=1", token)
    active = campaign_state(config) == "active"
    if active:
        day = campaign_day(config, on)
        target_day, target_stars = target_for_day(config, max(day, 1))
        heading = "# Star path dashboard"
        status = f"Updated: {on.isoformat()} · campaign day {day} · next checkpoint {target_stars} stars by day {target_day}"
    else:
        heading = "# Repository metrics"
        status = f"Updated: {on.isoformat()} · campaign state {campaign_state(config).upper()} · no star checkpoint is active"
    lines = [
        heading,
        "",
        status,
        "",
        "| Metric | Current |",
        "|---|---:|",
    ]
    if repo_data:
        lines.extend(
            [
                f"| Stars | {repo_data.get('stargazers_count', 'n/a')} |",
                f"| Forks | {repo_data.get('forks_count', 'n/a')} |",
                f"| Open issues and pull requests | {repo_data.get('open_issues_count', 'n/a')} |",
                f"| Watchers | {repo_data.get('subscribers_count', 'n/a')} |",
            ]
        )
    else:
        lines.append("| Repository metrics | unavailable |")
    if traffic_views:
        lines.append(f"| Unique visitors (rolling 14 days) | {traffic_views.get('uniques', 'n/a')} |")
        lines.append(f"| Views (rolling 14 days) | {traffic_views.get('count', 'n/a')} |")
    if traffic_clones:
        lines.append(f"| Unique cloners (rolling 14 days) | {traffic_clones.get('uniques', 'n/a')} |")
        lines.append(f"| Clones (rolling 14 days) | {traffic_clones.get('count', 'n/a')} |")
    if isinstance(contributors, list):
        lines.append(f"| Contributors returned by API | {len(contributors)} |")
    errors = [error for error in (repo_error, views_error, clones_error, contributor_error) if error]
    lines.extend(
        [
            "",
            "## Interpretation checklist",
            "",
            "- Compare traffic to successful demo runs and installs; GitHub stars alone do not establish activation.",
            "- Record partner applications, qualified operators, installs, weekly use, and approved proof in the weekly growth issue.",
            "- If traffic grows without installs, fix the promise, demo, or setup before scheduling more launches.",
        ]
    )
    if errors:
        lines.extend(["", "## API notes", ""])
        lines.extend(f"- {markdown_escape(error)}" for error in errors)
        lines.append("- Traffic endpoints may be unavailable to tokens without repository push access; no custom secret is otherwise required.")
    return "\n".join(lines) + "\n"


def score_candidate(item: dict[str, Any], config: dict[str, Any], on: dt.date) -> tuple[int, list[str]]:
    score = 0
    reasons: list[str] = []
    searchable = " ".join(
        [
            str(item.get("name") or ""),
            str(item.get("description") or ""),
            " ".join(item.get("topics") or []),
        ]
    ).lower()
    keyword_matches = sorted(
        keyword for keyword in config["qualification"]["required_keywords"] if keyword.lower() in searchable
    )
    if not keyword_matches:
        return -1, ["no explicit relevance in repository metadata"]
    if keyword_matches == ["codex"] and not any(
        keyword.lower() in searchable for keyword in config["qualification"]["codex_context_keywords"]
    ):
        return -1, ["ambiguous Codex match without AI or developer context"]
    score += 2
    reasons.append("relevant metadata: " + ", ".join(keyword_matches[:3]))
    pushed_at = item.get("pushed_at")
    if pushed_at:
        pushed = dt.datetime.fromisoformat(pushed_at.replace("Z", "+00:00")).date()
        if (on - pushed).days <= config["qualification"]["active_within_days"]:
            score += 2
            reasons.append("recently active")
    topics = set(item.get("topics") or [])
    matches = topics.intersection(config["qualification"]["preferred_topics"])
    if matches:
        score += min(2, len(matches))
        reasons.append("matching topics: " + ", ".join(sorted(matches)))
    stars = int(item.get("stargazers_count") or 0)
    if 5 <= stars <= 500:
        score += 1
        reasons.append("adjacent early-stage community")
    if item.get("has_issues"):
        score += 1
        reasons.append("public issue channel")
    return score, reasons


def discovery_report(on: dt.date, limit: int) -> str:
    config, _, _ = require_valid()
    token = github_token()
    candidates: dict[str, tuple[dict[str, Any], int, list[str]]] = {}
    errors: list[str] = []
    for query in config["discovery_queries"]:
        path = "/search/repositories?" + urllib.parse.urlencode({"q": query, "sort": "updated", "order": "desc", "per_page": limit})
        response, error = optional_github_get(path, token)
        if error:
            errors.append(f"Query {query!r}: {error}")
            continue
        for item in response.get("items", []):
            score, reasons = score_candidate(item, config, on)
            if score < config["qualification"]["minimum_score"] or item.get("archived") or item.get("fork"):
                continue
            key = item["full_name"]
            previous = candidates.get(key)
            if previous is None or score > previous[1]:
                candidates[key] = (item, score, reasons)
    ordered = sorted(candidates.values(), key=lambda entry: (-entry[1], -entry[0].get("stargazers_count", 0), entry[0]["full_name"]))
    lines = [
        "# Adjacent-project discovery report",
        "",
        f"Generated {on.isoformat()} from public repository metadata. These are projects to understand—not a cold-outreach list.",
        "",
        "| Project | Score | Stars | Why it surfaced | Safe next step |",
        "|---|---:|---:|---|---|",
    ]
    for item, score, reasons in ordered:
        name = markdown_escape(item["full_name"])
        url = item["html_url"]
        lines.append(
            f"| [{name}]({url}) | {score} | {item.get('stargazers_count', 0)} | "
            f"{markdown_escape('; '.join(reasons))} | Read docs/issues; respond only to an explicit relevant request or invite maintainers to a public opt-in event through an approved owned channel. |"
        )
    if not ordered:
        lines.append("| No qualified projects found | — | — | Refine queries or retry after API limits reset | Do not compensate with scraped personal data |")
    lines.extend(
        [
            "",
            "## Approval boundary",
            "",
            "Automation stops here. Do not send unsolicited issues, pull requests, email, or direct messages. A maintainer may learn from public artifacts, answer a question that asks for this solution, or invite people through a general public call for partners.",
        ]
    )
    if errors:
        lines.extend(["", "## API notes", ""])
        lines.extend(f"- {markdown_escape(error)}" for error in errors)
    return "\n".join(lines) + "\n"


def heartbeat(on: dt.date, include_metrics: bool) -> str:
    config, schedule, queue = require_valid()
    if campaign_state(config) != "active":
        state = campaign_state(config)
        identity_status = (
            "Exact replacement name has not been approved."
            if state == "frozen"
            else "The campaign is not active."
        )
        lines = [
            "# Daily growth heartbeat",
            "",
            f"Date: {on.isoformat()} · campaign state: **{state.upper()}**",
            "",
            "## Readiness only",
            "",
            f"- {identity_status}",
            "- The 90-day clock and star checkpoints are suspended.",
            "- Launch drafts, releases, public distribution, and outreach remain blocked.",
            "- Product validation and repository metrics may continue.",
        ]
        if include_metrics:
            lines.extend(["", "---", "", metrics_report(on)])
        return "\n".join(lines).rstrip() + "\n"
    day = campaign_day(config, on)
    start_day = max(1, day)
    upcoming = relevant_events(schedule, start_day, min(config["duration_days"], start_day + 2))
    overdue = relevant_events(schedule, max(1, day - 7), day - 1) if day > 1 else []
    content = due_content(queue, start_day, min(config["duration_days"], start_day + 2))
    target_day, target_stars = target_for_day(config, max(day, 1))
    lines = [
        "# Daily growth heartbeat",
        "",
        f"Date: {on.isoformat()} · campaign day {day} · next checkpoint: {target_stars} stars by day {target_day}",
        "",
        "## Next 72 hours",
        "",
    ]
    if upcoming:
        for event in upcoming:
            gate = "HUMAN GATE" if event["human_gate"] else "automated/read-only"
            lines.append(f"- [ ] Day {event['day']}: {event['deliverable']} — **{gate}**")
    else:
        lines.append("- No scheduled milestone.")
    lines.extend(["", "## Draft queue", ""])
    if content:
        for item in content:
            lines.append(f"- [ ] `{item['id']}` for {item['channel']} ({item['status']}); generate with `python3 scripts/growth.py content --id {item['id']}`.")
    else:
        lines.append("- No draft due in the next 72 hours.")
    lines.extend(["", "## Recent items requiring a human status check", ""])
    if overdue:
        for event in overdue:
            lines.append(f"- [ ] Day {event['day']}: {event['deliverable']}")
    else:
        lines.append("- None.")
    lines.extend(
        [
            "",
            "## Guardrail",
            "",
            "This heartbeat may generate drafts and reminders. It must not post to a community, contact a candidate, publish a release, or claim completion without a maintainer approval signal.",
        ]
    )
    if include_metrics:
        lines.extend(["", "---", "", metrics_report(on)])
    return "\n".join(lines).rstrip() + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("validate", help="validate all growth campaign data and templates")
    calendar_parser = subparsers.add_parser("calendar", help="render the dated 90-day calendar")
    calendar_parser.add_argument("--on", help="ISO date used only for the today marker")
    brief_parser = subparsers.add_parser("weekly", help="render the current weekly growth brief")
    brief_parser.add_argument("--on", help="ISO date; defaults to today in UTC")
    content_parser = subparsers.add_parser("content", help="render approval-gated content drafts")
    content_parser.add_argument("--on", help="ISO date; defaults to today in UTC")
    content_parser.add_argument("--id", help="render one content queue item by ID")
    content_parser.add_argument("--window", type=int, default=7, help="days to include when --id is omitted")
    metrics_parser = subparsers.add_parser("metrics", help="read GitHub API metrics and render a report")
    metrics_parser.add_argument("--on", help="ISO date; defaults to today in UTC")
    discovery_parser = subparsers.add_parser("discover", help="find adjacent public projects; never contacts them")
    discovery_parser.add_argument("--on", help="ISO date; defaults to today in UTC")
    discovery_parser.add_argument("--limit", type=int, default=10, help="results per configured query (1–30)")
    heartbeat_parser = subparsers.add_parser("heartbeat", help="single read-only entrypoint for a daily Codex heartbeat")
    heartbeat_parser.add_argument("--on", help="ISO date; defaults to today in UTC")
    heartbeat_parser.add_argument("--with-metrics", action="store_true", help="include live GitHub metrics")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "validate":
            errors = validate()
            if errors:
                for error in errors:
                    print(f"ERROR: {error}", file=sys.stderr)
                return 1
            print("Growth campaign configuration is valid.")
        elif args.command == "calendar":
            print(render_calendar(today(args.on) if args.on else None), end="")
        elif args.command == "weekly":
            print(weekly_brief(today(args.on)), end="")
        elif args.command == "content":
            if args.window < 1 or args.window > 30:
                parser.error("--window must be between 1 and 30")
            print(content_drafts(today(args.on), args.id, args.window), end="")
        elif args.command == "metrics":
            print(metrics_report(today(args.on)), end="")
        elif args.command == "discover":
            if args.limit < 1 or args.limit > 30:
                parser.error("--limit must be between 1 and 30")
            print(discovery_report(today(args.on), args.limit), end="")
        elif args.command == "heartbeat":
            print(heartbeat(today(args.on), args.with_metrics), end="")
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
