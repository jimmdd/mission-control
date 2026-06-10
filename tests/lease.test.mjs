import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MissionControlDB } from "../src/db.ts";

test("task leases prevent duplicate inbox claims until expiry", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-lease-"));
  const db = new MissionControlDB(join(dir, "mc.db"));

  try {
    db.initSchema();
    db.seedDefaults();
    const task = db.createTask({ title: "Lease me", priority: "urgent" });

    const claimed = db.claimNextInboxTask("bridge-a", 60);
    assert.equal(claimed?.id, task.id);
    assert.equal(claimed?.processing_owner, "bridge-a");
    assert.ok(claimed?.processing_expires_at);

    const duplicate = db.claimNextInboxTask("bridge-b", 60);
    assert.equal(duplicate, undefined);

    assert.equal(db.releaseTaskLease(task.id, "bridge-b"), false);
    assert.equal(db.releaseTaskLease(task.id, "bridge-a"), true);

    const reclaimed = db.claimNextInboxTask("bridge-b", 60);
    assert.equal(reclaimed?.id, task.id);
    assert.equal(reclaimed?.processing_owner, "bridge-b");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
