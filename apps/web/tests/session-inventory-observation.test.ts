import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitSessionInventoryObservation,
  clearSessionInventoryObservations,
  forgetSessionInventoryObservation,
  protectSessionInventoryOmission,
  recordSessionInventoryObservation,
} from "../src/session-inventory-observation.ts";
import {
  clearOfficeSnapshotRequestIdentities,
  latestOfficeSnapshotRequestIdentity,
  recordOfficeSnapshotRequestIdentity,
} from "../src/office-snapshot-request-tracker.ts";

const serverUrl = "http://127.0.0.1:4317";

test("promotion barriers are scoped and expire on a newer complete request", () => {
  clearSessionInventoryObservations();
  const issuedThrough = { serverUrl, connectionGeneration: 7, requestGeneration: 5 };
  awaitSessionInventoryObservation("profile-a", "stored-shared", issuedThrough);
  awaitSessionInventoryObservation("profile-b", "stored-shared", issuedThrough);

  assert.equal(protectSessionInventoryOmission("profile-a", "stored-shared", issuedThrough), true);
  assert.equal(protectSessionInventoryOmission("profile-b", "stored-shared", issuedThrough), true);

  const newer = { ...issuedThrough, requestGeneration: 6 };
  assert.equal(protectSessionInventoryOmission("profile-a", "stored-shared", newer), false);
  assert.equal(protectSessionInventoryOmission("profile-a", "stored-shared", issuedThrough), false);
  assert.equal(protectSessionInventoryOmission("profile-b", "stored-shared", issuedThrough), true);

  recordSessionInventoryObservation("profile-b", "stored-shared");
  assert.equal(protectSessionInventoryOmission("profile-b", "stored-shared", issuedThrough), false);

  awaitSessionInventoryObservation("profile-c", "stored-c", issuedThrough);
  forgetSessionInventoryObservation("profile-c", "stored-c");
  assert.equal(protectSessionInventoryOmission("profile-c", "stored-c", newer), false);

  awaitSessionInventoryObservation("profile-d", "stored-d", issuedThrough);
  clearSessionInventoryObservations();
  assert.equal(protectSessionInventoryOmission("profile-d", "stored-d", issuedThrough), false);
});

test("request tracking keeps the newest issued generation and resets cleanly", () => {
  clearOfficeSnapshotRequestIdentities();
  const applied = { serverUrl, connectionGeneration: 11, requestGeneration: 2 };
  recordOfficeSnapshotRequestIdentity({ ...applied, requestGeneration: 4 });
  recordOfficeSnapshotRequestIdentity({ ...applied, requestGeneration: 3 });
  assert.deepEqual(latestOfficeSnapshotRequestIdentity(applied), {
    ...applied,
    requestGeneration: 4,
  });

  clearOfficeSnapshotRequestIdentities();
  assert.deepEqual(latestOfficeSnapshotRequestIdentity(applied), applied);
});
