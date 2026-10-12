// 平らな値一式で保存していた描画の品質設定の読み替え(src/render/legacy-graphics-settings.ts)の回帰
// テスト。旧い保存値の意味は凍結されているので、読み替えて解いた値を値で固定する — 本番のプリセットの値が
// 変わっても、旧い保存値が指す絵は変わらない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { DEFAULT_GRAPHICS_SELECTION, resolveGraphics } from '../../src/render/graphics-selection';
import { parseLegacyGraphics } from '../../src/render/legacy-graphics-settings';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 旧い「高」の保存値を読み替えて解いた値。旧い既定そのもの。
const LEGACY_HIGH: GraphicsSettingsData = {
  resolutionScale: 1, antialias: 2, lodBias: 2,
  sunLightModel: 1, planetLightModel: 1, planetLightCount: 2, ambient: true,
  meshShadow: true, shadowSlotCount: 4, shadowSlotSize: 1024, shadowTexelsPerPixel: 1,
  clouds: true, cloudFieldSource: 'generated', cirrus: true, translucentCumulus: true,
  cumulus: true, cumulusMarchSteps: 6, cumulusRefineSteps: 3, cumulusShadow: true,
  atmosphere: true, atmosphereSampleBudget: 24, airglow: true, aurora: true,
  screenSpaceOcclusion: true, screenSpaceIndirect: true, screenSpaceSliceCount: 4, screenSpaceStepCount: 5,
  screenSpaceSpecular: true, screenSpaceSpecularScale: 0.5, screenSpaceSpecularStepCount: 32,
  screenSpaceSpecularDenoise: true,
  pointField: true, rings: true, lens: true, proteinVibration: true,
  exposureCompensation: 1, filmLut: 'none',
};

function resolvedLegacy(text: string | null): GraphicsSettingsData {
  return resolveGraphics(parseLegacyGraphics(text));
}

export function register(): void {
  test('legacy-graphics-settings: 実在の保存値が、旧い意味どおりの値に解ける', () => {
    const graphics = resolvedLegacy('{"lodBias":0.5,"clouds":false,"antialias":1,"shadowSlotSize":2048}');
    assert.equal(graphics.resolutionScale, 1);
    assert.equal(graphics.antialias, 1);
    assert.equal(graphics.lodBias, 0.5);
    assert.equal(graphics.clouds, false);
    assert.equal(graphics.meshShadow, true);
    assert.equal(graphics.shadowSlotSize, 2048);
    assert.equal(graphics.shadowSlotCount, 4);
    assert.equal(graphics.shadowTexelsPerPixel, 1);
    // 残りは旧い「高」のまま。
    const untouched = { ...LEGACY_HIGH, antialias: 1, lodBias: 0.5, clouds: false, shadowSlotSize: 2048 };
    for (const key of Object.keys(LEGACY_HIGH) as (keyof GraphicsSettingsData)[]) {
      if (key.startsWith('cumulus') || key === 'cloudFieldSource' || key === 'cirrus' || key === 'translucentCumulus') {
        continue;
      }
      assert.equal(graphics[key], untouched[key], key);
    }
  });

  test('legacy-graphics-settings: 旧い既定の保存値は、旧い「高」の値に解ける', () => {
    assert.deepEqual(resolvedLegacy('{}'), LEGACY_HIGH);
  });

  test('legacy-graphics-settings: 積雲の精細さがオフだった値は、積雲の立体オフと標準の刻み・二分になる', () => {
    const graphics = resolvedLegacy('{"cumulusDetail":0}');
    assert.equal(graphics.clouds, true);
    assert.equal(graphics.cumulus, false);
    assert.equal(graphics.cumulusMarchSteps, 6);
    assert.equal(graphics.cumulusRefineSteps, 3);
  });

  test('legacy-graphics-settings: 積雲の精細さの段は、段の表どおりの刻みと二分に展開する', () => {
    const coarse = resolvedLegacy('{"cumulusDetail":1}');
    assert.equal(coarse.cumulus, true);
    assert.equal(coarse.cumulusMarchSteps, 1);
    assert.equal(coarse.cumulusRefineSteps, 5);
    const fine = resolvedLegacy('{"cumulusDetail":3}');
    assert.equal(fine.cumulusMarchSteps, 12);
    assert.equal(fine.cumulusRefineSteps, 3);
  });

  test('legacy-graphics-settings: 大気の段は、有無と標本数に展開する', () => {
    assert.equal(resolvedLegacy('{"atmosphere":0}').atmosphere, false);
    const low = resolvedLegacy('{"atmosphere":1}');
    assert.equal(low.atmosphere, true);
    assert.equal(low.atmosphereSampleBudget, 8);
    assert.equal(resolvedLegacy('{"atmosphere":2}').atmosphereSampleBudget, 16);
  });

  test('legacy-graphics-settings: 遮蔽と照り返しの方式と精細さは、有無・照り返し・スライス数・歩数に展開する', () => {
    const off = resolvedLegacy('{"screenSpaceDiffuse":0}');
    assert.equal(off.screenSpaceOcclusion, false);
    const occlusion = resolvedLegacy('{"screenSpaceDiffuse":1,"screenSpaceQuality":0}');
    assert.equal(occlusion.screenSpaceOcclusion, true);
    assert.equal(occlusion.screenSpaceIndirect, false);
    assert.equal(occlusion.screenSpaceSliceCount, 2);
    assert.equal(occlusion.screenSpaceStepCount, 3);
    const indirect = resolvedLegacy('{"screenSpaceDiffuse":2,"screenSpaceQuality":2}');
    assert.equal(indirect.screenSpaceIndirect, true);
    assert.equal(indirect.screenSpaceSliceCount, 4);
    assert.equal(indirect.screenSpaceStepCount, 6);
  });

  test('legacy-graphics-settings: 映り込みの精細さは、追跡の解像度と歩数に展開する', () => {
    const low = resolvedLegacy('{"screenSpaceSpecularQuality":0}');
    assert.equal(low.screenSpaceSpecularScale, 0.5);
    assert.equal(low.screenSpaceSpecularStepCount, 16);
    const high = resolvedLegacy('{"screenSpaceSpecularQuality":2}');
    assert.equal(high.screenSpaceSpecularScale, 1);
    assert.equal(high.screenSpaceSpecularStepCount, 48);
  });

  test('legacy-graphics-settings: 好みの 2 つは好みへ移り、候補外は保存が無いときの値', () => {
    const selection = parseLegacyGraphics('{"exposureCompensation":0.25,"filmLut":"no-such-look"}');
    assert.equal(selection.preferences.exposureCompensation, 0.25);
    assert.equal(selection.preferences.filmLut, 'none');
  });

  test('legacy-graphics-settings: 知らないキーは読まず、候補外の値は旧い既定', () => {
    const graphics = resolvedLegacy('{"lodBias":7,"clouds":"yes","unknownOption":1}');
    assert.equal(graphics.lodBias, LEGACY_HIGH.lodBias);
    assert.equal(graphics.clouds, LEGACY_HIGH.clouds);
    assert.ok(!('unknownOption' in graphics));
  });

  test('legacy-graphics-settings: 壊れた文字列と null は保存が無いときの選び方', () => {
    assert.deepEqual(parseLegacyGraphics(null), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseLegacyGraphics('{"lodBias":0.5'), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseLegacyGraphics('3'), DEFAULT_GRAPHICS_SELECTION);
  });
}
