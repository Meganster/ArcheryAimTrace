import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAxisMapping, FIRMWARE_MOUNTS } from "../app/telemetry/mount-mapping.js";

test("compiled firmware transforms match browser coordinate composition for all profiles", () => {
  const probe = spawnSync("cc", ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "A C compiler (cc) is required for firmware mounting tests.");
  const dir = mkdtempSync(join(tmpdir(), "openfloat-mount-"));
  const source = join(dir, "mount-test.c");
  const includeDir = fileURLToPath(new URL("../firmware/src/", import.meta.url));
  writeFileSync(source, `
#include <stdio.h>
#include "mount_axes.h"
int main(void) {
  const float vectors[][3] = {{1,0,0}, {0,1,0}, {0,0,1}, {3,-4,12}};
  for (int i = 0; i < 4; i++) {
    float x = vectors[i][0], y = vectors[i][1], z = vectors[i][2];
    openfloat_mount_rotate(&x, &y, &z);
    printf("%g %g %g\\n", (double)x, (double)y, (double)z);
  }
  return 0;
}
`);
  try {
    for (const [index, [profile, mapping]] of Object.entries(FIRMWARE_MOUNTS).entries()) {
      const binary = join(dir, `mount-${index}`);
      const build = spawnSync("cc", [
        "-std=c99", "-Wall", "-Wextra", "-Werror", `-DOPENFLOAT_MOUNT=${index}`,
        "-I", includeDir, source, "-o", binary,
      ], { encoding: "utf8" });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const actual = run.stdout.trim().split("\n").map((line) => line.split(" ").map(Number));
      const expected = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [3, -4, 12]]
        .map((vector) => applyAxisMapping(mapping, vector));
      assert.deepEqual(actual, expected, profile);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
