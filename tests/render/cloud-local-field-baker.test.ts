import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { v3 } from '../../src/math/vec3';
import { CloudLocalFieldBaker } from '../../src/render/cloud/cloud-local-field-baker';
import type {
  CloudLocalFieldFrame, CloudLocalFieldSupply, CloudLocalFieldSupplyResult,
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
}
