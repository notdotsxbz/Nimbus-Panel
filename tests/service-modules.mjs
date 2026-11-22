import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const servicesDir = path.join(root, "services");
const schema = JSON.parse(fs.readFileSync(path.join(servicesDir, "module.schema.json"), "utf8"));
assert.equal(schema.type, "object");
const required = new Set(schema.required ?? []);
for (const key of ["name", "label", "software"]) assert(required.has(key), "module schema must require " + key);

const folders = fs.readdirSync(servicesDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
const modules = [];
for (const folder of folders) {
  const file = path.join(servicesDir, folder.name, "module.json");
  if (!fs.existsSync(file)) continue;
  const module = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(module.name, /^[a-z]+$/, folder.name + " has an invalid module name");
  assert.equal(module.name, folder.name, folder.name + " folder and module name must match");
  assert.equal(typeof module.label, "string");
  assert.equal(typeof module.requiresPort, "boolean");
  assert.ok(Array.isArray(module.protocols) && module.protocols.length > 0);
  assert.ok(Array.isArray(module.software) && module.software.length > 0);
  for (const item of module.software) {
    for (const key of ["id", "label", "image", "minRamMb"]) assert.ok(item[key] !== undefined, module.name + " software entry is missing " + key);
    assert.equal(typeof item.image, "string");
    assert.ok(Number.isInteger(item.minRamMb) && item.minRamMb >= 128);
    assert.ok(Array.isArray(item.versions));
  }
  modules.push(module.name);
}
for (const name of ["minecraft", "discord", "websites", "backends", "databases", "docker", "virtualization", "nodejs", "python", "mongodb", "lavalink", "custom"]) {
  assert.ok(modules.includes(name), "missing supported service module: " + name);
}
console.log("Validated " + modules.length + " service modules: " + modules.sort().join(", "));
