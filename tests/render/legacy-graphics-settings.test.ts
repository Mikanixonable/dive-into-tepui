// 平らな値一式で保存していた描画の品質設定の読み替え(src/render/legacy-graphics-settings.ts)の回帰
// テスト。旧い保存値の意味は凍結されているので、読み替えて解いた値を値で固定する — 本番のプリセットの値が
// 変わっても、旧い保存値が指す絵は変わらない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  DEFAULT_GRAPHICS_SELECTION, firstRunGraphicsSelection, resolveGraphics,
} from '../../src/render/graphics-selection';
import { parseLegacyGraphics } from '../../src/render/legacy-graphics-settings';
import type { GraphicsSettingsData } from '../../src/render/graphics-settings';

// 旧い品質プリセット「中」の保存値。旧い形式で保存が無いときの値でもある。
const LEGACY_MEDIUM = {
  resolutionScale: 0.5, lodBias: 0.5, exposureCompensation: 1, hitShake: true, filmLut: 'none', antialias: 1,
  frameRateCap: 60, uiBlur: true, textureResolution: 1, pointField: true, rings: true, aurora: false,
  atmosphere: 1, airglow: true, clouds: true, cloudFieldSource: 'generated', cumulus: true, cirrus: true,
  cumulusDetail: 1, cirrusDetail: 0, lens: true, thrustPlume: 'volume', sunLightModel: 1, planetLightModel: 0,
  planetLightCount: 2, ambient: true, nightObservation: false, constructionWorkLight: true, meshShadow: true,
  cloudShadow: true, shadowSlotCount: 4, shadowSlotSize: 1024, shadowTexelsPerPixel: 0.5,
} as const;

// 旧い品質プリセット「最高」の保存値。
const LEGACY_MAX = {
  ...LEGACY_MEDIUM,
  resolutionScale: 1, lodBias: 2, antialias: 2, frameRateCap: 0, textureResolution: 2, aurora: true, atmosphere: 3,
  cumulusDetail: 2, cirrusDetail: 1, planetLightModel: 1, shadowTexelsPerPixel: 1,
} as const;

function resolvedLegacy(text: string | null): GraphicsSettingsData {
  return resolveGraphics(parseLegacyGraphics(text));
}

export function register(): void {
  test('legacy-graphics-settings: 旧いプリセットそのままの保存値は、同じ名前の全体のプリセットへ読み替わる', () => {
    assert.equal(parseLegacyGraphics(JSON.stringify(LEGACY_MEDIUM)).quality, 'medium');
    assert.equal(parseLegacyGraphics(JSON.stringify(LEGACY_MAX)).quality, 'max');
    assert.equal(parseLegacyGraphics('{}').quality, 'medium', '旧い既定が中に読み替わらない');
  });

  test('legacy-graphics-settings: 実在の保存値が、旧い意味どおりの値に解ける', () => {
    const graphics = resolvedLegacy('{"lodBias":1,"clouds":false,"antialias":2,"shadowSlotSize":2048}');
    assert.equal(graphics.resolutionScale, 0.5);
    assert.equal(graphics.antialias, 2);
    assert.equal(graphics.lodBias, 1);
    assert.equal(graphics.clouds, false);
    assert.equal(graphics.meshShadow, true);
    assert.equal(graphics.shadowSlotSize, 2048);
    assert.equal(graphics.shadowSlotCount, 4);
    assert.equal(graphics.shadowTexelsPerPixel, 0.5);
    assert.equal(graphics.frameRateCap, 60);
  });

  test('legacy-graphics-settings: 旧い形式に無い分野は、既定の全体のプリセットが選ぶものになる', () => {
    const fallback = resolveGraphics(DEFAULT_GRAPHICS_SELECTION);
    const graphics = resolvedLegacy('{"lodBias":1}');
    assert.equal(graphics.screenSpaceOcclusion, fallback.screenSpaceOcclusion);
    assert.equal(graphics.screenSpaceSliceCount, fallback.screenSpaceSliceCount);
    assert.equal(graphics.screenSpaceSpecular, fallback.screenSpaceSpecular);
  });

  test('legacy-graphics-settings: main で足された項目は値どおりに読める', () => {
    const graphics = resolvedLegacy(
      '{"frameRateCap":30,"uiBlur":false,"textureResolution":0,"thrustPlume":"simple",'
      + '"nightObservation":true,"constructionWorkLight":false,"cloudShadow":false,"cirrusDetail":2}',
    );
    assert.equal(graphics.frameRateCap, 30);
    assert.equal(graphics.uiBlur, false);
    assert.equal(graphics.textureResolution, 0);
    assert.equal(graphics.thrustPlume, 'simple');
    assert.equal(graphics.nightObservation, true);
    assert.equal(graphics.constructionWorkLight, false);
    assert.equal(graphics.cloudShadow, false);
    assert.equal(graphics.cirrusDetail, 2);
  });

  test('legacy-graphics-settings: 積雲の表示を持たず精細さがオフだった値は、積雲オフになる', () => {
    const graphics = resolvedLegacy('{"cumulusDetail":0}');
    assert.equal(graphics.clouds, true);
    assert.equal(graphics.cumulus, false);
    // 表示を持つ値では表示のほうを優先する。
    assert.equal(resolvedLegacy('{"cumulusDetail":0,"cumulus":true}').cumulus, true);
  });

  test('legacy-graphics-settings: 積雲の精細さの段は、段の表どおりの刻み・二分・細部の段数に展開する', () => {
    const coarse = resolvedLegacy('{"cumulusDetail":1}');
    assert.deepEqual(
      [coarse.cumulusMarchSteps, coarse.cumulusRefineSteps, coarse.cumulusOctaves], [1, 5, 4]);
    const standard = resolvedLegacy('{"cumulusDetail":2}');
    assert.deepEqual(
      [standard.cumulusMarchSteps, standard.cumulusRefineSteps, standard.cumulusOctaves], [6, 3, 6]);
    const fine = resolvedLegacy('{"cumulusDetail":3}');
    assert.deepEqual([fine.cumulusMarchSteps, fine.cumulusRefineSteps, fine.cumulusOctaves], [12, 3, 8]);
  });

  test('legacy-graphics-settings: 大気の段は、有無と標本数に展開する', () => {
    assert.equal(resolvedLegacy('{"atmosphere":0}').atmosphere, false);
    const low = resolvedLegacy('{"atmosphere":1}');
    assert.equal(low.atmosphere, true);
    assert.equal(low.atmosphereSampleBudget, 8);
    assert.equal(resolvedLegacy('{"atmosphere":2}').atmosphereSampleBudget, 16);
    assert.equal(resolvedLegacy('{"atmosphere":3}').atmosphereSampleBudget, 24);
  });

  test('legacy-graphics-settings: 好みは好みへ移り、候補外は保存が無いときの値', () => {
    const selection = parseLegacyGraphics(
      '{"exposureCompensation":0.7071067811865476,"filmLut":"no-such-look","hitShake":false}');
    assert.equal(selection.preferences.exposureCompensation, 0.7071067811865476);
    assert.equal(selection.preferences.filmLut, 'none');
    assert.equal(selection.preferences.hitShake, false);
  });

  test('legacy-graphics-settings: 知らないキーは読まず、候補外の値は旧い既定', () => {
    const graphics = resolvedLegacy('{"lodBias":7,"clouds":"yes","unknownOption":1,"proteinVibration":false}');
    assert.equal(graphics.lodBias, LEGACY_MEDIUM.lodBias);
    assert.equal(graphics.clouds, LEGACY_MEDIUM.clouds);
    assert.ok(!('unknownOption' in graphics));
    assert.ok(!('proteinVibration' in graphics));
  });

  test('legacy-graphics-settings: 壊れた文字列は保存が無いときの選び方、null はポインタで選ぶ初回の選び方', () => {
    assert.deepEqual(parseLegacyGraphics(null), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseLegacyGraphics(null, true), firstRunGraphicsSelection(true));
    assert.deepEqual(parseLegacyGraphics('{"lodBias":0.5'), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseLegacyGraphics('3'), DEFAULT_GRAPHICS_SELECTION);
  });
}
