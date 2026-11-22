import * as assert from 'node:assert/strict';
import { deployGroupVisibility } from '../../src/game/hud/panels/vessel-panel';
import { test } from '../harness';

export function register(): void {
  test('vessel deploy visibility: 両群とも両側装備していれば区画も全ボタンも出す', () => {
    assert.deepEqual(deployGroupVisibility(true, true, true, true), {
      showSolarUp: true, showSolarDown: true, showRadiatorUp: true, showRadiatorDown: true,
      showContainer: true,
    });
  });

  test('vessel deploy visibility: 標準戦闘艦は放熱板の無い側だけ畳む', () => {
    // パドル両側と放熱板の片側だけを積む船。区画は残り、放熱板の無い側のボタンだけ畳む。
    assert.deepEqual(deployGroupVisibility(true, true, true, false), {
      showSolarUp: true, showSolarDown: true, showRadiatorUp: true, showRadiatorDown: false,
      showContainer: true,
    });
  });

  test('vessel deploy visibility: パドル片側だけの船はそのボタンだけ残す', () => {
    assert.deepEqual(deployGroupVisibility(true, false, false, false), {
      showSolarUp: true, showSolarDown: false, showRadiatorUp: false, showRadiatorDown: false,
      showContainer: true,
    });
  });

  test('vessel deploy visibility: 放熱板片側だけの船はそのボタンだけ残す', () => {
    assert.deepEqual(deployGroupVisibility(false, false, false, true), {
      showSolarUp: false, showSolarDown: false, showRadiatorUp: false, showRadiatorDown: true,
      showContainer: true,
    });
  });

  test('vessel deploy visibility: どちらも無ければ区画ごと畳む', () => {
    assert.deepEqual(deployGroupVisibility(false, false, false, false), {
      showSolarUp: false, showSolarDown: false, showRadiatorUp: false, showRadiatorDown: false,
      showContainer: false,
    });
  });
}
