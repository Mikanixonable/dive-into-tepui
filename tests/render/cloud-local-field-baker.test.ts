import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { CloudLocalFieldBaker } from '../../src/render/cloud/cloud-local-field-baker';
import type {
  CloudLocalFieldFrame, CloudLocalFieldJob, CloudLocalFieldSupply,
  CloudLocalFieldSupplyResult,
} from '../../src/render/cloud/cloud-local-field';
import type { CloudOpticalVolumeData } from '../../src/render/cloud/cloud-optical-volume';

const CENTER = v3(0, 0, 1);
const MOVED_CENTER = v3(Math.sin(0.02), 0, Math.cos(0.02)); // 中心から 0.02 rad 離れた方向
const LAYER_EDGES_M = [0, 1_000];

function frame(): CloudLocalFieldFrame {
  return {
    centerDirection: CENTER,
    eastDirection: v3(1, 0, 0),
    northDirection: v3(0, 1, 0),
    sphereRadiusM: 6_371_000,
    gridOriginEastM: -4_000,
    gridOriginNorthM: -4_000,
    cellWidthM: 2_000,
    cellHeightM: 2_000,
    gridWidth: 4,
    gridHeight: 4,
    maxAngularDistanceRad: Math.hypot(4_000, 4_000) / 6_371_000,
    layerEdgesM: LAYER_EDGES_M,
  };
}

function data(): CloudOpticalVolumeData {
  return {
    width: 4,
    height: 4,
    layerEdgesM: new Float32Array(LAYER_EDGES_M),
    liquidExtinctionPerM: new Float32Array(16).fill(1e-4),
    iceExtinctionPerM: new Float32Array(16).fill(5e-5),
  };
}

// derive の呼び出し回数を数える供給源。fail を立てると例外を投げる。
function countingSupply(fail = false): { readonly supply: CloudLocalFieldSupply; calls: { n: number } } {
  const calls = { n: 0 };
  return {
    calls,
    supply: {
      derive: (): CloudLocalFieldSupplyResult | null => {
        calls.n += 1;
        if (fail) throw new RangeError('supply failed');
        return { frame: frame(), data: data() };
      },
    },
  };
}

// steps 回の step で done になるジョブ。throwAt を渡すとその回の step が例外を投げる。
function scriptedJob(steps: number, throwAt = -1): CloudLocalFieldJob & {
  steps: number;
  cancels: number;
} {
  const job = {
    steps: 0,
    cancels: 0,
    step: (): { readonly done: boolean } => {
      job.steps += 1;
      if (job.steps === throwAt) throw new RangeError('job failed');
      return { done: job.steps >= steps };
    },
    get result(): CloudLocalFieldSupplyResult | null {
      return job.steps >= steps ? { frame: frame(), data: data() } : null;
    },
    cancel: (): void => { job.cancels += 1; },
  };
  return job;
}

export function register(): void {
  test('cloud local field baker: 供給源が無ければ binding は null のまま', () => {
    const baker = new CloudLocalFieldBaker(null);
    baker.maybeRebuild(0, CENTER);
    assert.equal(baker.binding, null);
    baker.dispose();
  });

  test('cloud local field baker: 初回は構築し、条件を満たさなければ焼き直さない', () => {
    const { supply, calls } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    assert.ok(baker.binding !== null);
    const first = baker.binding!;
    baker.maybeRebuild(299, CENTER);
    assert.equal(calls.n, 1);
    assert.equal(baker.binding, first);
    baker.dispose();
  });

  test('cloud local field baker: 時間経過と中心移動のどちらでも再焼し、前の体積は次の再焼まで生きる', () => {
    const { supply, calls } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    const firstTexture = baker.binding!.texture;
    let firstDisposed = 0;
    firstTexture.addEventListener('dispose', () => { firstDisposed += 1; });

    // 時間経過で再焼。前の texture は保持分としてまだ生きている。
    baker.maybeRebuild(300, CENTER);
    assert.equal(calls.n, 2);
    assert.notEqual(baker.binding!.texture, firstTexture);
    assert.equal(firstDisposed, 0);

    // 中心移動で再焼。1つ前の体積はここで破棄される。
    baker.maybeRebuild(600, MOVED_CENTER);
    assert.equal(calls.n, 3);
    assert.equal(firstDisposed, 1);
    baker.dispose();
  });

  test('cloud local field baker: 導出失敗は握り潰して次の呼び出しで再試行する', () => {
    // 例外を投げる供給源: 未構築のまま留まり、呼ぶたびに再試行する。
    const { supply: failing, calls: failCalls } = countingSupply(true);
    const failingBaker = new CloudLocalFieldBaker(failing);
    failingBaker.maybeRebuild(0, CENTER);
    assert.equal(failingBaker.binding, null);
    failingBaker.maybeRebuild(1, CENTER);
    assert.equal(failCalls.n, 2);
    failingBaker.dispose();

    // null を返す供給源: 同じく未構築のまま、呼ぶたびに再試行する。
    const nullCalls = { n: 0 };
    const nullBaker = new CloudLocalFieldBaker({
      derive: () => { nullCalls.n += 1; return null; },
    });
    nullBaker.maybeRebuild(0, CENTER);
    nullBaker.maybeRebuild(1, CENTER);
    assert.equal(nullCalls.n, 2);
    assert.equal(nullBaker.binding, null);
    nullBaker.dispose();
  });

  test('cloud local field baker: 構築済みの場は導出失敗しても現行のまま保つ', () => {
    let fail = false;
    const flaky: CloudLocalFieldSupply = {
      derive: () => {
        if (fail) throw new RangeError('supply failed');
        return { frame: frame(), data: data() };
      },
    };
    const baker = new CloudLocalFieldBaker(flaky, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    const built = baker.binding!;
    fail = true;
    // 間隔を超えても試行は失敗し、現行の場を崩さない。
    baker.maybeRebuild(300, CENTER);
    assert.equal(baker.binding, built);
    // 失敗で間隔は解消しないので、次の呼び出しも再試行になる。
    baker.maybeRebuild(301, CENTER);
    assert.equal(baker.binding, built);
    baker.dispose();
  });

  test('cloud local field baker: 計測口は試行・世代・体積の容量を記録する', () => {
    const { supply } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    const empty = baker.bakeStats;
    assert.equal(empty.generation, 0);
    assert.equal(empty.bindingTextureUuid, null);
    assert.equal(empty.attempts.length, 0);
    assert.equal(empty.volumeBytes.estimatedGpuBaseLevelBytes, 0);
    assert.equal(empty.volumeBytes.cpuBackingBytes, 0);

    // 焼き上げると、成功した試行が時刻・各段の時間・転送量推定とともに残る。
    baker.maybeRebuild(0, CENTER);
    let stats = baker.bakeStats;
    assert.equal(stats.generation, 1);
    assert.equal(stats.bindingTextureUuid, baker.binding!.texture.uuid);
    assert.equal(stats.attempts.length, 1);
    const attempt = stats.attempts[0]!;
    assert.equal(attempt.sequence, 0);
    assert.equal(attempt.displayTimeSeconds, 0);
    assert.equal(attempt.rebuilt, true);
    assert.ok(Number.isFinite(attempt.deriveMs) && attempt.deriveMs >= 0);
    assert.ok(Number.isFinite(attempt.volumeBuildMs) && attempt.volumeBuildMs >= 0);
    // 4×4×1 層の RG32F: 16 texel × 2 成分 × 4 byte。
    assert.equal(attempt.estimatedGpuBaseLevelBytes, 128);
    assert.equal(stats.volumeBytes.estimatedGpuBaseLevelBytes, 128);
    assert.equal(stats.volumeBytes.cpuBackingBytes, 8 + 64 + 64 + 128);

    // 再焼で前の体積は保持分へ回り、合計は交換のピークとして2体分が読める。
    baker.maybeRebuild(300, CENTER);
    stats = baker.bakeStats;
    assert.equal(stats.generation, 2);
    assert.equal(stats.attempts.length, 2);
    assert.equal(stats.attempts[1]!.sequence, 1);
    assert.equal(stats.volumeBytes.estimatedGpuBaseLevelBytes, 256);
    assert.equal(stats.volumeBytes.cpuBackingBytes, 528);
    baker.dispose();
  });

  test('cloud local field baker: 失敗した試行も計測へ残り、世代は進まない', () => {
    const { supply } = countingSupply(true);
    const baker = new CloudLocalFieldBaker(supply);
    baker.maybeRebuild(0, CENTER);
    const stats = baker.bakeStats;
    assert.equal(stats.generation, 0);
    assert.equal(stats.bindingTextureUuid, null);
    assert.equal(stats.attempts.length, 1);
    const attempt = stats.attempts[0]!;
    assert.equal(attempt.rebuilt, false);
    assert.equal(attempt.estimatedGpuBaseLevelBytes, 0);
    assert.equal(attempt.volumeBuildMs, 0);
    assert.ok(Number.isFinite(attempt.deriveMs) && attempt.deriveMs >= 0);
    assert.equal(stats.volumeBytes.estimatedGpuBaseLevelBytes, 0);
    baker.dispose();
  });

  test('cloud local field baker: 試行記録は直近へ絞られる', () => {
    const { supply } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply, 1, 0.01);
    for (let index = 0; index < 20; index += 1) baker.maybeRebuild(index * 2, CENTER);
    const stats = baker.bakeStats;
    assert.equal(stats.generation, 20);
    assert.equal(stats.attempts.length, 16);
    // 古い順に残る — 上限を超えて落ちた分は sequence が飛ぶので、先頭は 4 番目の試行。
    assert.equal(stats.attempts[0]!.sequence, 4);
    assert.equal(stats.attempts[0]!.displayTimeSeconds, 8);
    assert.equal(stats.attempts[15]!.sequence, 19);
    baker.dispose();
  });

  test('cloud local field baker: dispose は現行と保持分の texture を解放する', () => {
    const { supply } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    const first = baker.binding!.texture;
    baker.maybeRebuild(300, CENTER);
    const second = baker.binding!.texture;
    let disposed = 0;
    first.addEventListener('dispose', () => { disposed += 1; });
    second.addEventListener('dispose', () => { disposed += 1; });
    baker.dispose();
    assert.equal(disposed, 2);
    assert.equal(baker.binding, null);
  });

  test('cloud local field baker: 非単位ベクトル・非有限の時刻は RangeError', () => {
    const { supply } = countingSupply();
    const baker = new CloudLocalFieldBaker(supply);
    assert.throws(() => baker.maybeRebuild(0, v3(1, 1, 0)), RangeError);
    assert.throws(() => baker.maybeRebuild(Number.NaN, CENTER), RangeError);
    assert.throws(() => baker.maybeRebuild(0, v3(0, 0, 0)), RangeError);
    baker.dispose();
  });

  test('cloud local field baker: 分割ジョブは呼び出しごとに進み、完了で場を差し替える', () => {
    let started = 0;
    const jobs: ReturnType<typeof scriptedJob>[] = [];
    const supply: CloudLocalFieldSupply = {
      derive: () => { throw new Error('startJob のある供給源では同期導出を使わない'); },
      startJob: () => {
        started += 1;
        const job = scriptedJob(3);
        jobs.push(job);
        return job;
      },
    };
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    // 1ジョブ3駆動。完了まで binding は立たず、試行記録にも積まれない。
    baker.maybeRebuild(0, CENTER);
    assert.equal(baker.binding, null);
    baker.maybeRebuild(1, CENTER);
    assert.equal(baker.binding, null);
    assert.equal(baker.bakeStats.attempts.length, 0);
    baker.maybeRebuild(2, CENTER);
    assert.ok(baker.binding !== null);
    assert.equal(started, 1);
    assert.equal(jobs[0]!.steps, 3);
    const attempt = baker.bakeStats.attempts.at(-1)!;
    assert.equal(attempt.stepCount, 3);
    assert.equal(attempt.rebuilt, true);
    assert.equal(attempt.displayTimeSeconds, 0);
    baker.dispose();
  });

  test('cloud local field baker: ジョブの駆動中は現行の場を使い続ける', () => {
    let started = 0;
    const supply: CloudLocalFieldSupply = {
      derive: () => null,
      startJob: () => {
        started += 1;
        return scriptedJob(started === 1 ? 1 : 2);
      },
    };
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    const first = baker.binding!;
    // 2回掛かる再焼の1駆動目では、まだ前の場が有効。
    baker.maybeRebuild(300, CENTER);
    assert.equal(baker.binding, first);
    baker.maybeRebuild(301, CENTER);
    assert.notEqual(baker.binding, first);
    baker.dispose();
  });

  test('cloud local field baker: ジョブの途中失敗は畳んで現行場を保ち、次で新しいジョブへ再試行する', () => {
    let started = 0;
    const jobs: ReturnType<typeof scriptedJob>[] = [];
    const supply: CloudLocalFieldSupply = {
      derive: () => null,
      startJob: () => {
        started += 1;
        const job = started === 2 ? scriptedJob(3, 2) : scriptedJob(2);
        jobs.push(job);
        return job;
      },
    };
    const baker = new CloudLocalFieldBaker(supply, 300, 0.01);
    baker.maybeRebuild(0, CENTER);
    baker.maybeRebuild(1, CENTER);
    const first = baker.binding!;
    // 2個目のジョブは2駆動目で失敗する。1駆動目は進み、失敗後も現行場を保つ。
    baker.maybeRebuild(300, CENTER);
    assert.equal(baker.binding, first);
    baker.maybeRebuild(301, CENTER);
    assert.equal(baker.binding, first);
    assert.equal(jobs[1]!.cancels, 1);
    const failed = baker.bakeStats.attempts.at(-1)!;
    assert.equal(failed.rebuilt, false);
    assert.equal(failed.stepCount, 2);
    assert.equal(baker.bakeStats.generation, 1);
    // 失敗試行は間隔を解消しないので、次の呼び出しは新しいジョブを始める。
    baker.maybeRebuild(302, CENTER);
    baker.maybeRebuild(303, CENTER);
    assert.equal(started, 3);
    assert.notEqual(baker.binding, first);
    baker.dispose();
  });

  test('cloud local field baker: startJob の例外は失敗試行として記録する', () => {
    let started = 0;
    const supply: CloudLocalFieldSupply = {
      derive: () => null,
      startJob: () => {
        started += 1;
        throw new RangeError('cannot start');
      },
    };
    const baker = new CloudLocalFieldBaker(supply);
    baker.maybeRebuild(0, CENTER);
    const attempt = baker.bakeStats.attempts.at(-1)!;
    assert.equal(attempt.rebuilt, false);
    assert.equal(attempt.stepCount, 0);
    assert.equal(baker.binding, null);
    baker.maybeRebuild(1, CENTER);
    assert.equal(started, 2);
    assert.equal(baker.bakeStats.attempts.length, 2);
    baker.dispose();
  });
}
