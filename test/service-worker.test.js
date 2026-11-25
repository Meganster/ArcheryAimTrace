import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../service-worker.js", import.meta.url), "utf8");

test("versioned tracking modules never fall back to a different cached build", async () => {
  const requests = [];
  const context = vm.createContext({
    self: { addEventListener() {} }, URL,
    Response: { error: () => "missing-build" },
    caches: { match: async (_request, options) => {
      requests.push(options);
      return options?.ignoreSearch ? "old-module" : undefined;
    } },
  });
  vm.runInContext(source, context);
  const result = await vm.runInContext('cachedFallback({url: "http://localhost/app/telemetry/aim-projection.js?v=" + TRACKING_BUILD})', context);
  assert.equal(result, "missing-build");
  assert.equal(requests.length, 1);
  const next = await vm.runInContext('cachedFallback({url: "http://localhost/app/telemetry/aim-projection.js?v=aim-pipeline-999"})', context);
  assert.equal(next, "missing-build");
  assert.equal(requests.length, 2);
});

test("service worker precaches exact module URLs and revalidates online requests", async () => {
  const listeners = new Map();
  const fetched = [];
  const cached = [];
  const context = vm.createContext({
    self: {
      location: { origin: "http://localhost" },
      addEventListener: (event, callback) => listeners.set(event, callback),
      skipWaiting() {},
    }, URL, console,
    caches: { open: async () => ({ addAll: async (paths) => cached.push(...paths) }) },
    fetch: async (request, options) => { fetched.push({ request, options }); return { status: 204, ok: false }; },
  });
  vm.runInContext(source, context);
  let pending;
  listeners.get("install")({ waitUntil: (value) => { pending = value; } });
  await pending;
  const build = vm.runInContext("TRACKING_BUILD", context);
  for (const path of ["app/main.js", "app/telemetry/aim-projection.js", "app/telemetry/telemetry.js", "app/ui/trace-chart.js"]) {
    assert.ok(cached.includes(`./${path}?v=${build}`));
  }
  listeners.get("fetch")({
    request: { method: "GET", url: "http://localhost/app/main.js" },
    respondWith: (value) => { pending = value; },
  });
  await pending;
  assert.equal(fetched.at(-1).options.cache, "no-cache");
});
