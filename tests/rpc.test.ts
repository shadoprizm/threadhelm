import test from "node:test";
import assert from "node:assert/strict";
import {
  Rpc,
  TESTED_CODEX_PROTOCOL_VERSIONS,
  assessCodexProtocol,
} from "../src/rpc.js";

test("the Codex protocol probe enables only an explicitly tested version", () => {
  const version = TESTED_CODEX_PROTOCOL_VERSIONS[0],
    accepted = assessCodexProtocol({
      userAgent: `Codex Desktop/${version} (Mac OS; arm64) terminal`,
    });
  assert.equal(accepted.compatible, true);
  assert.equal(accepted.version, version);

  for (const current of ["0.155.1", "0.155.0-alpha.9.2"])
    assert.equal(
      assessCodexProtocol({
        userAgent: `Codex Desktop/${current} (Mac OS; arm64) terminal`,
      }).compatible,
      true,
      current,
    );

  const newerAlpha = assessCodexProtocol({
    userAgent: "Codex Desktop/0.155.0-alpha.1 (Linux; x86_64) terminal",
  });
  assert.equal(newerAlpha.compatible, false);
  assert.match(newerAlpha.error, /has not passed/);
});

test("missing or malformed protocol identity fails closed", () => {
  assert.equal(assessCodexProtocol({}).compatible, false);
  assert.equal(
    assessCodexProtocol({ userAgent: "unknown" }).version,
    "unknown",
  );
});

test("a host can declare an additional version only after its own probe", () => {
  const version = "0.153.0-alpha.9";
  assert.equal(
    assessCodexProtocol({ userAgent: `Codex CLI/${version} (Linux; x86_64)` }, [
      version,
    ]).compatible,
    true,
  );
});

test("the App Server's ThreadHelm user-agent form is recognized", () => {
  const version = "0.151.0-alpha.7.2",
    result = assessCodexProtocol({
      userAgent: `threadhelm/${version} (Ubuntu; x86_64) unknown (threadhelm; 0.3.1)`,
    });
  assert.equal(result.version, version);
  assert.equal(result.compatible, true);
});

test("an incompatible runtime cannot receive an approval response", () => {
  const rpc = new Rpc({ id: "test", name: "Test", codex: "unused" });
  rpc.ready = true;
  rpc.generation = "current";
  rpc.protocolChecked = true;
  rpc.controlAvailable = false;
  rpc.controlError = "Unverified protocol";
  let writes = 0;
  (rpc as any).write = () => writes++;
  assert.throws(
    () => rpc.respond(1, { decision: "accept" }, "current"),
    /Unverified protocol/,
  );
  assert.equal(writes, 0);
});
