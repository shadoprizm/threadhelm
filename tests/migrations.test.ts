import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

test("ordered migrations back up an existing database and preserve an actor-auditable rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "threadhelm-migration-")),
    database = join(directory, "control.sqlite");
  try {
    const legacy = new DatabaseSync(database);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES(1,1),(2,2);
      CREATE TABLE commands(id TEXT PRIMARY KEY, task_key TEXT, kind TEXT, body TEXT, status TEXT, result TEXT, created_at INTEGER, updated_at INTEGER);
      INSERT INTO commands VALUES('legacy','local:one','message','{}','accepted','{}',1,1);
    `);
    legacy.close();

    const store = new Store(database);
    assert.deepEqual(
      store.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row: any) => row.version),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(store.command("legacy").actor, "owner");
    store.beginCommand(
      "coordinator-command",
      "local:one",
      "message",
      {},
      "coordinator",
    );
    assert.equal(store.command("coordinator-command").actor, "coordinator");
    store.close();

    const backups = readdirSync(join(directory, "migration-backups"));
    assert.equal(backups.length, 5);
    const actorBackupName = backups.find((name) => name.includes("before-v3"));
    assert.ok(actorBackupName);
    const backup = join(directory, "migration-backups", actorBackupName);
    assert.equal(statSync(backup).mode & 0o777, 0o600);

    const rollback = join(directory, "restored.sqlite");
    copyFileSync(backup, rollback);
    const restored = new DatabaseSync(rollback),
      columns = restored.prepare("PRAGMA table_info(commands)").all() as Array<{
        name: string;
      }>;
    assert.equal(
      columns.some((column) => column.name === "actor"),
      false,
    );
    assert.equal(
      (restored.prepare("SELECT id FROM commands").get() as any).id,
      "legacy",
    );
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
