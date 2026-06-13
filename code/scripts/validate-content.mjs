import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const contentDir = join(root, "content");

const readJson = (name) => JSON.parse(readFileSync(join(contentDir, name), "utf8"));

const files = {
  artifacts: readJson("artifacts.json"),
  properties: readJson("properties.json"),
  tricks: readJson("tricks.json"),
  events: readJson("events.json"),
  missions: readJson("missions.json"),
  roles: readJson("roles.json")
};

const errors = [];
const warnings = [];
const implementedCustomTricks = new Set([
  "B01",
  "B02",
  "B04",
  "B05",
  "B06",
  "B08",
  "C01",
  "C03",
  "D01",
  "D02",
  "D03",
  "D04",
  "D05",
  "D06",
  "D07",
  "R01",
  "R02",
  "R03",
  "R04",
  "R05"
]);
const forbiddenResolvers = new Set(["logOnly"]);

function expect(condition, message) {
  if (!condition) errors.push(message);
}

function ids(items) {
  return items.map((item) => item.id);
}

function unique(values, label) {
  const seen = new Set();
  for (const value of values) {
    expect(!seen.has(value), `${label} duplicate id: ${value}`);
    seen.add(value);
  }
}

function sequence(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, "0")}`);
}

const categoryCounts = new Map();
for (const artifact of files.artifacts) {
  categoryCounts.set(artifact.category, (categoryCounts.get(artifact.category) ?? 0) + 1);
  expect(Number.isInteger(artifact.rumorMin) && Number.isInteger(artifact.rumorMax), `artifact ${artifact.id} has invalid rumor range`);
  expect(artifact.rumorMin < artifact.rumorMax, `artifact ${artifact.id} min must be lower than max`);
  expect(Array.isArray(artifact.propertyPool) && artifact.propertyPool.length > 0, `artifact ${artifact.id} needs propertyPool`);
}

expect(files.artifacts.length === 240, `expected 240 artifacts, got ${files.artifacts.length}`);
expect(categoryCounts.size === 12, `expected 12 artifact categories, got ${categoryCounts.size}`);
for (const [category, count] of categoryCounts) expect(count === 20, `category ${category} expected 20 artifacts, got ${count}`);

expect(files.properties.length === 31, `expected 31 properties, got ${files.properties.length}`);
expect(files.tricks.length === 43, `expected 43 tricks, got ${files.tricks.length}`);
expect(files.events.length === 30, `expected 30 events including natural events, got ${files.events.length}`);
expect(files.events.filter((event) => event.natural).length === 2, "expected 2 natural events");
expect(files.missions.length === 52, `expected 52 missions, got ${files.missions.length}`);
expect(files.roles.length === 9, `expected 9 roles, got ${files.roles.length}`);

for (const [name, list] of Object.entries(files)) unique(ids(list), name);

for (const missionId of sequence("W", 52)) expect(ids(files.missions).includes(missionId), `missing mission ${missionId}`);
for (const eventId of sequence("E", 28)) expect(ids(files.events).includes(eventId), `missing event ${eventId}`);
for (const eventId of ["N1", "N2"]) expect(ids(files.events).includes(eventId), `missing natural event ${eventId}`);

const propertyIds = new Set([...ids(files.properties), "fake"]);
for (const artifact of files.artifacts) {
  for (const propertyId of artifact.propertyPool) expect(propertyIds.has(propertyId), `artifact ${artifact.id} references missing property ${propertyId}`);
}

const banned = [/TODO/i, /TBD/i, /待补/, /占位/, /建议重做/, /调整后可用/];
for (const [name, list] of Object.entries(files)) {
  for (const item of list) {
    const text = JSON.stringify(item);
    for (const pattern of banned) expect(!pattern.test(text), `${name} ${item.id} contains banned marker ${pattern}`);
    for (const resolver of collectResolvers(item)) {
      expect(!forbiddenResolvers.has(resolver), `${name} ${item.id} contains forbidden resolver ${resolver}`);
    }
  }
}

for (const trick of files.tricks) {
  expect(Array.isArray(trick.effects) && trick.effects.length > 0, `trick ${trick.id} needs effects`);
  if (trick.effects.some((effect) => effect.type === "custom") && !implementedCustomTricks.has(trick.id)) warnings.push(`trick ${trick.id} uses custom resolver`);
}

for (const event of files.events) {
  expect(Array.isArray(event.effects) && event.effects.length > 0, `event ${event.id} needs effects`);
}

for (const role of files.roles) {
  expect(Array.isArray(role.skills) && role.skills.length >= 2, `role ${role.id} should have at least 2 skills`);
}

function collectResolvers(value) {
  const resolvers = [];
  function walk(item) {
    if (!item || typeof item !== "object") return;
    if (typeof item.resolver === "string") resolvers.push(item.resolver);
    if (Array.isArray(item)) item.forEach(walk);
    else Object.values(item).forEach(walk);
  }
  walk(value);
  return resolvers;
}

const declaredContentVersion = readJson("content-version.json").contentVersion;
const contentVersion = createHash("sha256").update(stableStringify(files)).digest("hex").slice(0, 16);
expect(declaredContentVersion === contentVersion, `content-version.json is ${declaredContentVersion}, expected ${contentVersion}`);
const report = {
  ok: errors.length === 0,
  contentVersion,
  counts: Object.fromEntries(Object.entries(files).map(([name, list]) => [name, list.length])),
  errors,
  warnings
};

writeFileSync(join(contentDir, "validation-report.json"), `${JSON.stringify(report, null, 2)}\n`);

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
