import * as assert from 'node:assert/strict';
import { deployGroupVisibility } from '../../src/game/hud/panels/vessel-panel';
import { test } from '../harness';

export function register(): void {
  test('vessel deploy visibility: 両方装備していれば区画も両群も出す', () => {
    assert.deepEqual(deployGroupVisibility(true, true), {
      showSolar: true, showRadiator: true, showContainer: true,
    });
  });

  test('vessel deploy visibility: パドルだけの船はパドル群だけ残し、放熱板群を畳む', () => {
    assert.deepEqual(deployGroupVisibility(true, false), {
      showSolar: true, showRadiator: false, showContainer: true,
    });
  });

  test('vessel deploy visibility: 放熱板だけの船は放熱板群だけ残し、パドル群を畳む', () => {
    assert.deepEqual(deployGroupVisibility(false, true), {
      showSolar: false, showRadiator: true, showContainer: true,
    });
  });

  test('vessel deploy visibility: どちらも無ければ区画ごと畳む', () => {
    assert.deepEqual(deployGroupVisibility(false, false), {
      showSolar: false, showRadiator: false, showContainer: false,
    });
  });
}
