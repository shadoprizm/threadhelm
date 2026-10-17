import datetime as dt
import importlib.util
import os
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("growth", ROOT / "scripts" / "growth.py")
assert SPEC and SPEC.loader
growth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(growth)


class GrowthAutomationTest(unittest.TestCase):
    def test_campaign_is_valid(self):
        self.assertEqual(growth.validate(), [])

    def test_calendar_is_suspended_until_campaign_activation(self):
        calendar = growth.render_calendar()
        self.assertIn("Growth calendar suspended", calendar)
        self.assertNotIn("Review the 1,000-star target", calendar)

    def test_every_outbound_schedule_event_has_a_human_gate(self):
        _, schedule, _ = growth.require_valid()
        outbound = {"launch", "distribution", "content", "proof", "release", "recruitment", "community"}
        self.assertTrue(all(event["human_gate"] for event in schedule["events"] if event["kind"] in outbound))

    def test_content_template_has_approval_marker(self):
        config, _, queue = growth.require_valid()
        config = {
            **config,
            "campaign_state": "active",
            "approved_product_name": config["product_name"],
            "approved_repository": config["repository"],
            "launch_date": config["start_date"],
        }
        item = next(item for item in queue["items"] if item["id"] == "show-hn")
        draft = growth.render_item(config, item)
        self.assertIn("Draft only — human approval required", draft)
        self.assertIn("Automation must never submit", draft)
        self.assertIn("TODO_", draft)

    def test_brand_freeze_blocks_drafts_and_campaign_clock(self):
        draft = growth.content_drafts(dt.date(2026, 10, 17), "show-hn", 7)
        self.assertIn("Content drafts blocked", draft)
        self.assertIn("FROZEN", draft)
        heartbeat = growth.heartbeat(dt.date(2026, 9, 19), include_metrics=False)
        self.assertIn("campaign state: **FROZEN**", heartbeat)
        self.assertIn("90-day clock and star checkpoints are suspended", heartbeat)
        self.assertNotIn("campaign day", heartbeat)

    def test_active_campaign_uses_the_approved_launch_date(self):
        config, _, _ = growth.require_valid()
        config = {
            **config,
            "campaign_state": "active",
            "approved_product_name": config["product_name"],
            "approved_repository": config["repository"],
            "launch_date": "2027-01-10",
        }
        self.assertEqual(growth.campaign_day(config, dt.date(2027, 1, 10)), 1)
        self.assertEqual(growth.event_date(config, 90), dt.date(2027, 4, 9))

    def test_frozen_metrics_do_not_reintroduce_star_deadlines(self):
        with mock.patch.object(growth, "github_token", return_value=None):
            with mock.patch.object(growth, "optional_github_get", return_value=(None, None)):
                report = growth.metrics_report(dt.date(2026, 10, 17))
        self.assertIn("campaign state FROZEN", report)
        self.assertNotIn("campaign day", report)
        self.assertNotIn("next checkpoint", report)

    def test_direct_content_renderer_refuses_frozen_brand(self):
        config, _, queue = growth.require_valid()
        with self.assertRaisesRegex(ValueError, "campaign_state=active"):
            growth.render_item(config, queue["items"][0])

    def test_every_public_issue_workflow_requires_an_active_campaign(self):
        workflows = [
            "growth-content.yml",
            "growth-discovery.yml",
            "growth-heartbeat.yml",
            "growth-weekly.yml",
            "founding-operator-onboarding.yml",
        ]
        for name in workflows:
            text = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
            self.assertIn("outputs.campaign_state == 'active'", text, name)

    def test_github_token_prefers_environment(self):
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "workflow-token"}):
            with mock.patch.object(growth.subprocess, "run") as run:
                self.assertEqual(growth.github_token(), "workflow-token")
        run.assert_not_called()

    def test_github_token_falls_back_to_authenticated_cli(self):
        completed = growth.subprocess.CompletedProcess(["gh", "auth", "token"], 0, "cli-token\n", "")
        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch.object(growth.subprocess, "run", return_value=completed):
                self.assertEqual(growth.github_token(), "cli-token")


if __name__ == "__main__":
    unittest.main()
