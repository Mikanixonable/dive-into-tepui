// 雲の種類ごとの曲線の不変条件を固定する。量が大きいほど高く不透明であること、量 0 が雲なしで
// あること、2 種類の高度幅と上端の大小関係(SPEC「雲の描画」)がここで検査できる。
import * as assert from 'node:assert/strict';
import {
  CIRRUS_ALTITUDE_SPAN, CIRRUS_MAX_OPTICAL_DEPTH, CIRRUS_TOP_ALTITUDE,
  CUMULUS_ALTITUDE_SPAN, CUMULUS_TOP_ALTITUDE,
  cirrusAmountFromOpticalDepth, cirrusColumnOpticalDepth, cirrusOpacity, cirrusTopAltitude,
  cumulusAmountFromOpacity, cumulusAmountFromTopAltitude, cumulusColumnOpticalDepth,
  cumulusOpacity, cumulusTopAltitude,
} from '../../src/render/cloud/cloud-kind';
import { test } from '../harness';

export function register(): void {
  test('cloud kind: 量が大きいほど雲頂は高く不透明度も高い', () => {
    const amounts = [0, 0.2, 0.5, 0.8, 1];
    for (let i = 1; i < amounts.length; i += 1) {
      assert.ok(cumulusTopAltitude(amounts[i]!) > cumulusTopAltitude(amounts[i - 1]!));
      assert.ok(cirrusTopAltitude(amounts[i]!) > cirrusTopAltitude(amounts[i - 1]!));
      assert.ok(cumulusOpacity(amounts[i]!) > cumulusOpacity(amounts[i - 1]!));
      assert.ok(cirrusOpacity(amounts[i]!) > cirrusOpacity(amounts[i - 1]!));
    }
  });

  test('cloud kind: 量 0 は光学的厚み 0(雲なし)', () => {
    assert.equal(cumulusColumnOpticalDepth(0), 0);
    assert.equal(cirrusColumnOpticalDepth(0), 0);
  });

  test('cloud kind: いちばん高い積雲は巻雲の高さを突き抜ける', () => {
    assert.equal(cumulusTopAltitude(1), CUMULUS_TOP_ALTITUDE);
    assert.equal(cirrusTopAltitude(1), CIRRUS_TOP_ALTITUDE);
    assert.ok(CUMULUS_TOP_ALTITUDE > CIRRUS_TOP_ALTITUDE);
  });

  test('cloud kind: 巻雲の高度幅は積雲より狭い', () => {
    assert.ok(CIRRUS_ALTITUDE_SPAN < CUMULUS_ALTITUDE_SPAN);
  });

  test('cloud kind: 逆写像は往復で量を戻し、範囲外の入力は端へ clamp する', () => {
    for (const amount of [0.05, 0.3, 0.7, 1]) {
      assert.ok(Math.abs(cumulusAmountFromTopAltitude(cumulusTopAltitude(amount)) - amount) < 1e-12);
      assert.ok(Math.abs(cumulusAmountFromOpacity(cumulusOpacity(amount)) - amount) < 1e-12);
      assert.ok(Math.abs(cirrusAmountFromOpticalDepth(cirrusColumnOpticalDepth(amount)) - amount) < 1e-12);
    }
    assert.equal(cumulusAmountFromTopAltitude(0), 0);
    assert.equal(cumulusAmountFromTopAltitude(1e6), 1);
    assert.ok(Math.abs(cumulusAmountFromOpacity(1) - 1) < 1e-12);
    assert.equal(cirrusAmountFromOpticalDepth(CIRRUS_MAX_OPTICAL_DEPTH * 2), 1);
  });

  test('cloud kind: 量 0.24 の積雲は下地をほぼ隠す', () => {
    assert.ok(cumulusOpacity(0.24) >= 0.8);
  });
}
