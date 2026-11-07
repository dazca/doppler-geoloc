// Node counterpart of geoloc_kernel_bench.html: node web/tests/geoloc_kernel_bench.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './geoloc_helpers.mjs';
import { kernelBenchSetup, kernelBenchRun } from './geoloc_kernel_bench_lib.mjs';
import { createGeolocPool, nodeWorkerFactory } from '../workers/geoloc-pool.js';
import os from 'node:os';

const env = await kernelBenchSetup({ readJson: async (p) => JSON.parse(await readFile(path.join(ROOT, p))), readBin: (p) => readFile(path.join(ROOT, p)) });
for (let k = 0; k < 3; k++) console.log('main thread:', JSON.stringify(kernelBenchRun(env)));
const factory = await nodeWorkerFactory();
for (const size of [1, os.availableParallelism?.() || 8]) {
  const pool = createGeolocPool({ size, factory });
  await pool.init(env.tracks, env.Z, env.spec, env.cfg);
  for (let k = 0; k < 3; k++) {
    const t = performance.now(), r = await pool.score(env.job), ms = performance.now() - t;
    console.log(`pool x${size}: ${ms.toFixed(0)} ms, ${(ms * 1e6 / r.evals).toFixed(2)} ns/sample (wall)`);
  }
  pool.close();
}
