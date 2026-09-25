// GPU 計測の行の並びと、雲の各表現がどの行として読めるかを固定する。
import * as assert from 'node:assert/strict';
import { TimestampQuery, type WebGPURenderer } from 'three/webgpu';
import {
  CLOUD_GPU_MEASUREMENTS, GPU_PASS, GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings,
} from '../../src/render/gpu-timings';
import { test } from '../harness';

interface TimestampPoolProbe {
  readonly timestamps: Map<string, number>;
}

interface InspectorProbe {
  beginRender(uid: string): void;
  finishRender(): void;
  beginCompute(uid: string): void;
}

function timingFixture(): {
  readonly timings: GpuTimings;
  readonly inspector: InspectorProbe;
  readonly renderTimestamps: TimestampPoolProbe;
  readonly computeTimestamps: TimestampPoolProbe;
} {
  const renderTimestamps = { timestamps: new Map<string, number>() };
  const computeTimestamps = { timestamps: new Map<string, number>() };
  const renderer = {
    backend: { timestampQueryPool: {
      [TimestampQuery.RENDER]: renderTimestamps,
      [TimestampQuery.COMPUTE]: computeTimestamps,
    } },
    resolveTimestampsAsync: async (type: string) => (type === TimestampQuery.RENDER ? 1 : 1),
  } as unknown as WebGPURenderer;
  const timings = new GpuTimings(renderer);
  timings.enabled = true;
  return {
    timings,
    inspector: renderer.inspector as unknown as InspectorProbe,
    renderTimestamps,
    computeTimestamps,
  };
}

export function register(): void {
  test('gpu timings: 行の名前が識別子と 1 対 1 に並ぶ', () => {
    assert.equal(GPU_PASS_COUNT, Object.keys(GPU_PASS).length);
    assert.equal(new Set(GPU_PASS_LABELS).size, GPU_PASS_COUNT);
  });

  test('gpu timings: 雲の計測範囲と行の名前が固定される', () => {
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.bake.pass], '雲の生成');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.atmosphere.pass], '大気(雲あり)');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.shadow.pass], '雲影');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.surface.pass], '表面雲');
    // 表面雲は雲殻だけの 2 回目の render() で計るので、単独の時刻として読める。
    assert.equal(CLOUD_GPU_MEASUREMENTS.surface.scope, 'exact');
  });

  test('gpu timings: observed render total includes tagged and untagged render UIDs and compute separately', async () => {
    const fixture = timingFixture();
    fixture.timings.beginObservedFrame();
    fixture.timings.beginPass(GPU_PASS.gbuffer);
    fixture.inspector.beginRender('tagged-render');
    fixture.inspector.finishRender();
    fixture.inspector.beginRender('untagged-render');
    fixture.inspector.finishRender();
    fixture.inspector.beginCompute('compute');
    fixture.timings.endObservedFrame();

    fixture.renderTimestamps.timestamps.set('tagged-render', 1.25);
    fixture.renderTimestamps.timestamps.set('untagged-render', 2.5);
    fixture.computeTimestamps.timestamps.set('compute', 0.75);
    fixture.timings.resolve();
    await fixture.timings.waitForResolve();

    const snapshot = fixture.timings.snapshot();
    assert.equal(snapshot.observedRenderComplete, true);
    assert.equal(snapshot.observedRenderExpectedQueryCount, 2);
    assert.equal(snapshot.observedRenderQueryCount, 2);
    assert.equal(snapshot.observedRenderTotalMs, 3.75);
    assert.equal(snapshot.observedComputeComplete, true);
    assert.equal(snapshot.observedComputeExpectedQueryCount, 1);
    assert.equal(snapshot.observedComputeQueryCount, 1);
    assert.equal(snapshot.observedComputeTotalMs, 0.75);
    assert.equal(snapshot.elapsedMs[GPU_PASS.gbuffer], 1.25);
  });

  test('gpu timings: missing render query prevents an observed render total from looking complete', async () => {
    const fixture = timingFixture();
    fixture.timings.beginObservedFrame();
    fixture.inspector.beginRender('render-with-missing-query');
    fixture.inspector.finishRender();
    fixture.timings.endObservedFrame();

    fixture.timings.resolve();
    await fixture.timings.waitForResolve();

    const snapshot = fixture.timings.snapshot();
    assert.equal(snapshot.observedRenderComplete, false);
    assert.equal(snapshot.observedRenderExpectedQueryCount, 1);
    assert.equal(snapshot.observedRenderTotalMs, null);
  });
}
