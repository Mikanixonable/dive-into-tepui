// GPU 計測の行の並びと、雲の各表現がどの行として読めるかを固定する。
import * as assert from 'node:assert/strict';
import { CLOUD_GPU_MEASUREMENTS, GPU_PASS, GPU_PASS_COUNT, GPU_PASS_LABELS } from '../../src/render/gpu-timings';
import { test } from '../harness';

export function register(): void {
  test('gpu timings: 行の名前が識別子と 1 対 1 に並ぶ', () => {
    assert.equal(GPU_PASS_COUNT, Object.keys(GPU_PASS).length);
    assert.equal(new Set(GPU_PASS_LABELS).size, GPU_PASS_COUNT);
    assert.deepEqual(Object.values(GPU_PASS), [...Array(GPU_PASS_COUNT).keys()]);
    assert.deepEqual(GPU_PASS_LABELS.slice(GPU_PASS.cloudShadow, GPU_PASS.lighting + 1), [
      '雲影', '照り返し源', '近傍拡散走査', '近傍拡散復元', 'ライティング',
    ]);
  });

  test('gpu timings: 雲の計測範囲と行の名前が固定される', () => {
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.bake.pass], '雲の生成');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.atmosphere.pass], '大気(雲あり)');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.shadow.pass], '雲影');
    assert.equal(GPU_PASS_LABELS[CLOUD_GPU_MEASUREMENTS.surface.pass], '表面雲');
    // 表面雲は雲殻だけの 2 回目の render() で計るので、単独の時刻として読める。
    assert.equal(CLOUD_GPU_MEASUREMENTS.surface.scope, 'exact');
  });
}
