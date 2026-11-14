// 月の摂動項テーブルの回帰テスト: 二体ケプラー解に含まれる項(中心差に相当する
// M' のみの行、黄緯の主傾斜に相当する F のみの行)が表へ二重計上として
// 紛れ込まないことを機械的に検査する。moon-terms.ts のコメントが参照する検査。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { MOON_DIST_TERMS, MOON_LAT_TERMS, MOON_LON_TERMS } from '../../src/game/celestial/solar-system/moon-terms';

const TABLES = {
  MOON_LON_TERMS,
  MOON_LAT_TERMS,
  MOON_DIST_TERMS,
} as const;

export function register(): void {
  test('satellite-orbit: 月の摂動項表にM\'のみの項(中心差の重複)が無い', () => {
    for (const [name, terms] of Object.entries(TABLES)) {
      for (const term of terms) {
        assert.ok(
          !(term.d === 0 && term.m === 0 && term.f === 0 && term.mp !== 0),
          `${name} に mp のみの項 d=${term.d} m=${term.m} mp=${term.mp} f=${term.f} がある`,
        );
      }
    }
  });

  test('satellite-orbit: 月の摂動項表にFのみの項(黄緯主傾斜の重複)が無い', () => {
    for (const [name, terms] of Object.entries(TABLES)) {
      for (const term of terms) {
        assert.ok(
          !(term.d === 0 && term.m === 0 && term.mp === 0 && term.f !== 0),
          `${name} に f のみの項 d=${term.d} m=${term.m} mp=${term.mp} f=${term.f} がある`,
        );
      }
    }
  });
}
