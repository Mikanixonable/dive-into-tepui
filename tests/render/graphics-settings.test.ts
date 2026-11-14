// 描画品質設定(src/render/graphics-settings.ts)の保存値互換テスト。項目の追加は
// 「既存の保存文字列に無い鍵は既定で埋まる」経路に乗る — 新項目が古い保存から
// 正しい既定へ落ちることと、書かれた値がそのまま読めることを見る。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  DEFAULT_GRAPHICS, QUALITY_PRESETS, parseGraphics, withGraphicsOption,
} from '../../src/render/graphics-settings';

export function register(): void {
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

  test('graphics-settings: 作業灯の書き換えが値一式へ反映される', () => {
    const data = withGraphicsOption(DEFAULT_GRAPHICS, 'constructionWorkLight', false);
    assert.equal(data.constructionWorkLight, false);
    // 候補外の型は捨てて現値を保つ。
    const kept = withGraphicsOption(data, 'constructionWorkLight', 'yes');
    assert.equal(kept.constructionWorkLight, false);
  });
}
