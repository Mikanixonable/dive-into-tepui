import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import { test } from '../harness';
import { MeteorologicalCloudField } from '../../src/render/cloud/meteorological-cloud-field';
import type { WebGPURenderer } from 'three/webgpu';
import type { FieldProjection } from '../../src/render/field-projection';
import type {
  CloudGlobalMassField, GlobalMassFieldJob, GlobalMassFieldResult, GlobalMassFieldSupply,
} from '../../src/render/cloud/global-mass-field';

// BakedField の render が触れる最小の口だけを持つスタブ。焼き込み自体は
// GPU が要るので描画は何もしない。
const stubRenderer = {
  setRenderTarget: (): void => {},
  render: (): void => {},
} as unknown as WebGPURenderer;

// 焼き直しの版だけが効く最小の投影。焼く式は TSL の定数で済ませる。
function testProjection(): FieldProjection & { advance(): void } {
  let revisionValue = 0;
  return {
    width: 4, height: 4,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    texelAngle: float(0.01),
    texelAngleValue: 0.01,
    get revision(): number { return revisionValue; },
    advance(): void { revisionValue += 1; },
    directionAt: () => vec3(0, 0, 1),
    uvAt: () => vec2(0, 0),
    insideAt: () => float(1),
  };
}

function massField(): CloudGlobalMassField {
  const liquidKgM2 = new Float64Array(8);
  liquidKgM2[0] = 0.2;
  return {
    width: 4, height: 2, sphereRadiusM: 6_371_000,
    layerEdgesM: [0, 2_000],
    liquidKgM2,
    iceKgM2: new Float64Array(8),
  };
}

// steps 回の step で done になるジョブ。field を渡すと完了時にそれを結果として返す。
// budgets には step へ渡された予算 [ms] が記録される。
function scriptedJob(steps: number, field: CloudGlobalMassField | null): GlobalMassFieldJob & {
  steps: number;
  cancels: number;
  budgets: number[];
} {
  const job = {
    steps: 0,
    cancels: 0,
    budgets: [] as number[],
    step: (budgetMs: number): { readonly done: boolean } => {
      job.steps += 1;
      job.budgets.push(budgetMs);
      return { done: job.steps >= steps };
    },
    get result(): GlobalMassFieldResult | null {
      return job.steps >= steps && field !== null ? { field } : null;
    },
    cancel: (): void => { job.cancels += 1; },
  };
  return job;
}

// startJob の呼び出しを数え、呼ぶたびに渡されたキューからジョブを出す供給源。
function queuedSupply(jobs: GlobalMassFieldJob[]): {
  readonly supply: GlobalMassFieldSupply;
  readonly times: number[];
} {
  const times: number[] = [];
  return {
    times,
    supply: {
      startJob: (displayTimeSeconds: number): GlobalMassFieldJob => {
        times.push(displayTimeSeconds);
        const job = jobs.shift();
        if (job === undefined) throw new Error('no scripted job left');
        return job;
      },
    },
  };
}

export function register(): void {
  test('meteorological cloud field: 契約の初期状態', () => {
    const { supply } = queuedSupply([scriptedJob(1, massField())]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    assert.ok(field.texture instanceof THREE.Texture);
    assert.equal(field.generation, 0);
    field.dispose();
  });

  test('meteorological cloud field: ジョブを駆動し、完了で場が更新される', () => {
    const job = scriptedJob(3, massField());
    const { supply, times } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 0);
    assert.equal(job.steps, 1);
    // 最初の prepare で空の場を一度焼く。
    assert.equal(field.generation, 1);
    field.prepare(stubRenderer, 0);
    assert.equal(job.steps, 2);
    assert.equal(field.generation, 1);
    field.prepare(stubRenderer, 0);
    assert.equal(job.steps, 3);
    // 場が届いたので焼き直し、世代が進む。
    assert.equal(field.generation, 2);
    // 同じ時刻では再導出しない。
    field.prepare(stubRenderer, 0);
    assert.deepEqual(times, [0]);
    field.dispose();
  });

  test('meteorological cloud field: 時刻の前進では走っているジョブを駆動し続ける', () => {
    const job = scriptedJob(5, massField());
    const { supply, times } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 0);
    field.prepare(stubRenderer, 120);
    // 微細な前進ごとにジョブを捨てると一生完成しないので、同じジョブを駆動し続ける。
    assert.equal(job.cancels, 0);
    assert.equal(job.steps, 2);
    assert.deepEqual(times, [0]);
    field.dispose();
  });

  test('meteorological cloud field: 時刻の後退ジャンプで走っているジョブを破棄して始め直す', () => {
    const first = scriptedJob(5, massField());
    const second = scriptedJob(1, massField());
    const { supply, times } = queuedSupply([first, second]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 120);
    // 未来の時刻へ進んでから現在より前へ戻る — 未来の天気を描かないよう引き直す。
    field.prepare(stubRenderer, 60);
    assert.equal(first.cancels, 1);
    assert.equal(second.steps, 1);
    assert.deepEqual(times, [120, 60]);
    field.dispose();
  });

  test('meteorological cloud field: 鮮度の間隔を超える前進で場を引き直す', () => {
    const first = scriptedJob(1, massField());
    const second = scriptedJob(1, massField());
    const third = scriptedJob(1, massField());
    const { supply, times } = queuedSupply([first, second, third]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 0);
    // 間隔(600 s)未満の前進では同じ場を使い回す。
    field.prepare(stubRenderer, 599);
    assert.deepEqual(times, [0]);
    // 間隔を超えると新しい時刻の場を導く。
    field.prepare(stubRenderer, 601);
    assert.equal(second.steps, 1);
    assert.deepEqual(times, [0, 601]);
    // 場の時刻より前へ戻ると、戻った時刻の場へ引き直す。
    field.prepare(stubRenderer, 300);
    assert.equal(third.steps, 1);
    assert.deepEqual(times, [0, 601, 300]);
    field.dispose();
  });

  test('meteorological cloud field: 結果が届かなければ前回の場を保つ', () => {
    const job = scriptedJob(1, null);
    const { supply } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 0);
    // 空の場の初回焼きだけが走り、場の版は進まない。
    assert.equal(field.generation, 1);
    const textureBefore = field.texture;
    field.prepare(stubRenderer, 0);
    assert.equal(field.generation, 1);
    assert.equal(field.texture, textureBefore);
    field.dispose();
  });

  test('meteorological cloud field: cap の置き方が変われば同じ場でも焼き直す', () => {
    const job = scriptedJob(1, massField());
    const { supply } = queuedSupply([job]);
    const projection = testProjection();
    const field = new MeteorologicalCloudField(supply, projection);
    // 1回の prepare でジョブが完了してから焼くので、初回から凝結済みの場になる。
    field.prepare(stubRenderer, 0);
    assert.equal(field.generation, 1);
    projection.advance();
    field.prepare(stubRenderer, 0);
    assert.equal(field.generation, 2);
    field.dispose();
  });

  test('meteorological cloud field: drivePendingJobs はフレーム外からジョブを前倒しで進める', () => {
    const job = scriptedJob(2, massField());
    const { supply } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    // prepare を待たずに供給を始めて駆動する。予算は呼び出し側のものがそのまま渡る。
    field.drivePendingJobs(stubRenderer, 0, 40);
    assert.equal(job.steps, 1);
    assert.equal(job.budgets[0], 40);
    field.drivePendingJobs(stubRenderer, 0, 40);
    // 場が届いて焼き直され、世代が進む。
    assert.equal(job.steps, 2);
    assert.equal(field.generation, 2);
    field.dispose();
  });

  test('meteorological cloud field: 最初の場が届くまではバースト予算で駆動する', () => {
    const first = scriptedJob(1, massField());
    const second = scriptedJob(1, massField());
    const { supply } = queuedSupply([first, second]);
    const field = new MeteorologicalCloudField(supply, testProjection(), null, 6, 16);
    field.prepare(stubRenderer, 0);
    assert.deepEqual(first.budgets, [16]);
    // 場が届いたあとの再供給は既定予算へ戻る。
    field.prepare(stubRenderer, 601);
    assert.deepEqual(second.budgets, [6]);
    field.dispose();
  });

  test('meteorological cloud field: 外部入力が読めるまで最初のジョブを遅らせる', () => {
    const job = scriptedJob(1, massField());
    const { supply, times } = queuedSupply([job]);
    const inputs = { ready: false };
    const field = new MeteorologicalCloudField(
      supply, testProjection(),
      { dispose: (): void => {}, cpuReadable: () => inputs.ready });
    field.prepare(stubRenderer, 0);
    field.drivePendingJobs(stubRenderer, 0, 40);
    assert.deepEqual(times, []);
    inputs.ready = true;
    field.drivePendingJobs(stubRenderer, 0, 40);
    assert.deepEqual(times, [0]);
    field.dispose();
  });

  test('meteorological cloud field: 入力を待つ上限を超えたら未着のまま開始する', () => {
    const job = scriptedJob(1, massField());
    const { supply, times } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(
      supply, testProjection(),
      { dispose: (): void => {}, cpuReadable: () => false },
      6, 16, 0);
    field.prepare(stubRenderer, 0);
    assert.deepEqual(times, [0]);
    field.dispose();
  });

  test('meteorological cloud field: fieldStats は駆動中の経過と試行記録を返す', () => {
    const job = scriptedJob(3, massField());
    const { supply } = queuedSupply([job]);
    const field = new MeteorologicalCloudField(supply, testProjection());
    field.prepare(stubRenderer, 0);
    const pending = field.fieldStats.pending;
    assert.ok(pending !== null);
    assert.equal(pending.stepCount, 1);
    assert.equal(pending.displayTimeSeconds, 0);
    assert.equal(field.fieldStats.hasField, false);
    field.prepare(stubRenderer, 0);
    field.prepare(stubRenderer, 0);
    const stats = field.fieldStats;
    assert.equal(stats.pending, null);
    assert.equal(stats.hasField, true);
    assert.equal(stats.attempts.length, 1);
    const attempt = stats.attempts[0]!;
    assert.equal(attempt.stepCount, 3);
    assert.equal(attempt.adopted, true);
    assert.ok(attempt.wallMs >= 0 && attempt.deriveMs >= 0);
    field.dispose();
  });
}
