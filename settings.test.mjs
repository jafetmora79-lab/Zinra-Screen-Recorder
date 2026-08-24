import {
  canExport,
  isPro,
  mergeExportCount,
  migrateSettings,
  remainingFreeExports,
  stripEntitlement
} from "./settings.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

assert(!isPro({ pro: true }), "pro without a license key is not Pro");
assert(isPro({ pro: true, licenseKey: "AAAA" }), "pro plus a key is Pro");

const flipped = migrateSettings({ pro: true, exportCount: 2 });
assert(flipped.pro === false, "migrate drops a lone pro flag");
assert(flipped.exportCount === 2, "migrate keeps exportCount");

const incoming = stripEntitlement({ clickZoom: 1.6, pro: true, licenseKey: "X", exportCount: 0 });
assert(incoming.pro === undefined && incoming.licenseKey === undefined && incoming.exportCount === undefined, "save-settings cannot touch entitlement");
assert(incoming.clickZoom === 1.6, "other settings still pass through");

assert(mergeExportCount(1, "3", null, 2) === 3, "export count uses the highest copy");

assert(canExport({ exportCount: 0 }) === true, "0 used can export");
assert(canExport({ exportCount: 2 }) === false, "2 used cannot export");
assert(canExport({ exportCount: 2, pro: true, licenseKey: "AAAA" }) === true, "Pro can still export");
assert(remainingFreeExports({ exportCount: 1 }) === 1, "one credit left");

console.log("settings entitlement checks passed");
