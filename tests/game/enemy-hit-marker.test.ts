// 敵マーカーの命中表示(損傷による色の変化と、命中直後の閃きの付与)の回帰テスト。色そのものの値は
// 調整値なので固定せず、満身・尽きた・その中間という関係だけを見る。
import * as assert from 'node:assert/strict';
import { enemyMarkerColor, COLOR_MARKER_ENEMY } from '../../src/game/marker/marker-identity';
import { withHitFlash, type GroupedMarkerItem } from '../../src/game/marker/grouped-markers';
import { v3 } from '../../src/math/vec3';
import { test } from '../harness';

// '#rrggbb' の赤・緑・青の成分。
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// cls だけを指定した項目。他の欄はこの点検では読まない。
function item(cls: string): GroupedMarkerItem {
  return {
    key: 'enemy-1', kind: 'enemy', cls, sym: '', pos: v3(), vel: v3(), priority: 0, name: 'e',
    bearing: { cls: '', sym: '', color: '', visible: false, clustered: false },
  } as unknown as GroupedMarkerItem;
}

export function register(): void {
  test('enemy-hit-marker: 満身の敵マーカーは基準の色のまま', () => {
    assert.equal(enemyMarkerColor(1).toLowerCase(), COLOR_MARKER_ENEMY.toLowerCase());
  });

  test('enemy-hit-marker: 残 HP が減るほど色が損傷色の側へ寄る', () => {
    const full = rgb(enemyMarkerColor(1));
    const half = rgb(enemyMarkerColor(0.5));
    const empty = rgb(enemyMarkerColor(0));
    // 緑の成分は損傷色の方が小さいので、残 HP が減るほど緑が落ちる。
    assert.ok(half[1] < full[1] && empty[1] < half[1], `緑の成分が単調に減っていない (${full[1]} → ${half[1]} → ${empty[1]})`);
    assert.ok(empty[1] < full[1], '尽きた色が満身の色と変わらない');
  });

  test('enemy-hit-marker: 残 HP の範囲外の値は端の色に丸める', () => {
    assert.equal(enemyMarkerColor(1.5), enemyMarkerColor(1));
    assert.equal(enemyMarkerColor(-0.5), enemyMarkerColor(0));
  });

  test('enemy-hit-marker: 閃きは既存のクラスを残したまま mk-hit を足す', () => {
    const flashed = withHitFlash(item('mk-enemy'));
    assert.ok(flashed.cls.split(' ').includes('mk-enemy'), '元のクラスが残っていない');
    assert.ok(flashed.cls.split(' ').includes('mk-hit'), '閃きのクラスが付いていない');
  });
}
