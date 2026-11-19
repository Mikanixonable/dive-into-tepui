// 描画品質設定(src/render/graphics-settings.ts)の保存値互換テスト。項目の追加は
// 「既存の保存文字列に無い鍵は既定で埋まる」経路に乗る — 新項目が古い保存から
// 正しい既定へ落ちることと、書かれた値がそのまま読めることを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  DEFAULT_GRAPHICS, QUALITY_PRESETS, formatGraphics, parseGraphics, withGraphicsOption,
} from '../../src/render/graphics-settings';

// 雲の表示切替と既存の描画設定の保存値互換性を検査する。
export function register(): void {
  test('graphics-settings: 積雲と巻雲は全プリセットで既定オン', () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      assert.equal(preset.cumulus, true);
      assert.equal(preset.cirrus, true);
    }
  });

  test('graphics-settings: 保存されていない雲トグルはオンで補完し、明示値は保持する', () => {
    const older = parseGraphics('{"clouds":true}');
    assert.equal(older.cumulus, true);
    assert.equal(older.cirrus, true);
    const saved = parseGraphics('{"cumulus":false,"cirrus":false}');
    assert.equal(saved.cumulus, false);
    assert.equal(saved.cirrus, false);
  });

  test('graphics-settings: 旧積雲オフを移行し、新しいトグルを優先する', () => {
    assert.equal(parseGraphics('{"cumulusDetail":0}').cumulus, false);
    assert.equal(parseGraphics('{"cumulusDetail":0,"cumulus":true}').cumulus, true);
    assert.equal(parseGraphics('{"cumulusDetail":0,"cumulus":false}').cumulus, false);
  });

  test('graphics-settings: 建造の作業灯は全プリセットで既定オン', () => {
    assert.equal(QUALITY_PRESETS.low.constructionWorkLight, true);
    assert.equal(QUALITY_PRESETS.medium.constructionWorkLight, true);
    assert.equal(QUALITY_PRESETS.high.constructionWorkLight, true);
    assert.equal(DEFAULT_GRAPHICS.constructionWorkLight, true);
  });

  test('graphics-settings: 項目追加前の保存文字列は作業灯が既定オンで埋まる', () => {
    // この項目が無かったころに書かれた保存文字列(実在の形式)。
    const graphics = parseGraphics(
      '{"lodBias":0.5,"clouds":false,"antialias":1,"shadowSlotSize":2048}');
    assert.equal(graphics.constructionWorkLight, true, '新項目が既定へ落ちない');
    assert.equal(graphics.lodBias, 0.5);
    assert.equal(graphics.clouds, false);
  });

  test('graphics-settings: 保存された作業灯の値はそのまま読める', () => {
    const on = parseGraphics('{"constructionWorkLight":true}');
    const off = parseGraphics('{"constructionWorkLight":false}');
    assert.equal(on.constructionWorkLight, true);
    assert.equal(off.constructionWorkLight, false);
  });

  test('graphics-settings: 作業灯の壊れた保存値は既定オンへ落ちる', () => {
    const graphics = parseGraphics('{"constructionWorkLight":"yes"}');
    assert.equal(graphics.constructionWorkLight, true);
  });

  test('graphics-settings: 保存が無いときの初回既定は、粗いポインタで medium、細かいポインタで high', () => {
    assert.deepEqual(parseGraphics(null, true), QUALITY_PRESETS.medium);
    assert.deepEqual(parseGraphics(null, false), QUALITY_PRESETS.high);
    assert.deepEqual(parseGraphics(null), DEFAULT_GRAPHICS);
  });

  test('graphics-settings: 保存済みの値はポインタ種別によらずそのまま読める', () => {
    const complete = formatGraphics(QUALITY_PRESETS.low);
    assert.deepEqual(parseGraphics(complete, true), QUALITY_PRESETS.low);
    assert.deepEqual(parseGraphics(complete, false), QUALITY_PRESETS.low);
    const partial = '{"lodBias":0.5,"clouds":false}';
    assert.deepEqual(parseGraphics(partial, true), parseGraphics(partial, false));
    assert.equal(parseGraphics(partial, true).lodBias, 0.5);
    assert.equal(parseGraphics(partial, true).clouds, false);
  });

  test('graphics-settings: 作業灯の書き換えが値一式へ反映される', () => {
    const data = withGraphicsOption(DEFAULT_GRAPHICS, 'constructionWorkLight', false);
    assert.equal(data.constructionWorkLight, false);
    // 候補外の型は捨てて現値を保つ。
    const kept = withGraphicsOption(data, 'constructionWorkLight', 'yes');
    assert.equal(kept.constructionWorkLight, false);
  });
}
