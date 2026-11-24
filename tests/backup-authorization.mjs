import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BackupsService } = require("../apps/api/dist/modules/backups/backups.service.js");

const serviceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const backupId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const service = {
  _id: { toString: () => serviceId },
  nodeId: { toString: () => "cccccccccccccccccccccccc" },
  ownerId: { toString: () => "dddddddddddddddddddddddd" },
};

async function rejectsCrossDriveDeletion() {
  let deleteCalls = 0;
  let tokenCalls = 0;
  const record = {
    _id: backupId,
    serviceId: service._id,
    driveOwnerType: "customer",
    destination: "gdrive",
    remoteFileId: "customer-drive-file",
    deleteOne: async () => { deleteCalls += 1; },
  };
  const svc = new BackupsService(
    { findById: async () => record },
    {},
    { get: async () => ({}) },
    { get: async () => service },
    { log: async () => undefined },
    { googleDriveAccessToken: async () => { tokenCalls += 1; return "token"; } },
  );

  await assert.rejects(
    svc.delete(backupId, { id: "eeeeeeeeeeeeeeeeeeeeeeee", role: "admin" }),
    error => error?.getStatus?.() === 404 || error?.status === 404,
    "an Admin must not delete a backup stored in a customer's personal Drive",
  );
  assert.equal(tokenCalls, 0, "Drive credentials must not be requested for a denied delete");
  assert.equal(deleteCalls, 0, "the MongoDB backup record must remain untouched");
}

async function allowsOwnLocalBackupDeletion() {
  let deleteCalls = 0;
  const record = {
    _id: backupId,
    serviceId: service._id,
    driveOwnerType: "customer",
    destination: "local",
    deleteOne: async () => { deleteCalls += 1; },
  };
  const svc = new BackupsService(
    { findById: async () => record },
    {},
    { get: async () => ({}), agentCall: async () => ({ deleted: true }) },
    { get: async () => service },
    { log: async () => undefined },
    { googleDriveAccessToken: async () => "unused" },
  );

  const result = await svc.delete(backupId, { id: service.ownerId.toString(), role: "customer" });
  assert.deepEqual(result, { deleted: true });
  assert.equal(deleteCalls, 1, "the owning customer may delete their own backup");
}

await rejectsCrossDriveDeletion();
await allowsOwnLocalBackupDeletion();
console.log("Backup authorization tests passed");
