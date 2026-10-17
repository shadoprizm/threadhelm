import importlib.util
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("doctor", ROOT / "scripts" / "doctor.py")
assert SPEC and SPEC.loader
doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doctor)


class DoctorTest(unittest.TestCase):
    def test_config_is_validated_without_reading_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            secret = root / "owner.token"
            secret.write_text("do-not-read", encoding="utf-8")
            secret.chmod(0o600)
            config = root / "config.json"
            config.write_text(
                json.dumps(
                    {
                        "port": 4318,
                        "hosts": [{"id": "local", "name": "Local"}],
                        "sources": [
                            {"adapter": "openwebui", "name": "Open WebUI", "tokenFile": str(secret)}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            parsed, checks = doctor.inspect_config(config)
            path_checks = doctor.local_config_paths(parsed)
            self.assertFalse(any("do-not-read" in check["detail"] for check in checks + path_checks))
            self.assertTrue(any("contents not read" in check["detail"] for check in path_checks))

    def test_unsafe_credentials_and_non_loopback_endpoints_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            token = pathlib.Path(directory) / "owner.token"
            token.write_text("secret", encoding="utf-8")
            token.chmod(0o644)
            checks = doctor.local_config_paths(
                {
                    "hosts": [{"id": "local"}],
                    "sources": [
                        {
                            "adapter": "openwebui",
                            "hostId": "local",
                            "baseUrl": "https://public.example.com",
                            "tokenFile": str(token),
                        }
                    ],
                    "runtime": {"baseUrl": "http://127.0.0.1:8082"},
                }
            )
            self.assertTrue(any(check["status"] == "fail" and "loopback" in check["detail"] for check in checks))
            self.assertTrue(any(check["status"] == "fail" and "0600" in check["detail"] for check in checks))

    def test_standard_source_directories_are_discovered(self):
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            (home / ".codex/sessions").mkdir(parents=True)
            checks = doctor.source_discovery(home)
            codex = next(check for check in checks if check["name"] == "Codex source")
            claude = next(check for check in checks if check["name"] == "Claude Code source")
            self.assertEqual(codex["status"], "pass")
            self.assertEqual(claude["status"], "warn")

    def test_remote_credential_paths_are_not_checked_on_the_local_machine(self):
        checks = doctor.local_config_paths(
            {
                "hosts": [{"id": "server", "ssh": "server.example"}],
                "sources": [
                    {
                        "adapter": "openclaw",
                        "hostId": "server",
                        "baseUrl": "ws://127.0.0.1:18789",
                        "tokenFile": "/remote/owner.token",
                    }
                ],
            }
        )
        self.assertEqual([check["name"] for check in checks], ["openclaw baseUrl"])
        self.assertEqual(checks[0]["status"], "pass")

    def test_missing_configuration_is_a_hard_failure(self):
        _, checks = doctor.inspect_config(pathlib.Path("/definitely/not/a/config.json"))
        self.assertEqual(checks[0]["status"], "fail")


if __name__ == "__main__":
    unittest.main()
