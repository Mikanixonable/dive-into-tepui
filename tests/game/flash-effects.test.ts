// 一時エフェクトの寿命と移流(game/vfx/flash-effects.ts)の回帰テスト。期待値の正本は
// 「寿命が尽きたら消える」「発生源の速度で運ばれる」という不変条件で、duration や大きさの
// 調整値そのものは固定しない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { FlashEffects } from '../../src/game/vfx/flash-effects';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';

// 発生位置 r、発生源速度 v、その位置が表す時刻 t のフラッシュ源。
function source(t: number, r = v3(1e6, 0, 0), v = v3(0, 0, 0)) {
  return kinematicState<'eci'>(t, r, v);
}

export function register(): void {
  test('flash-effects: spawn したものは live に並び、寿命が尽きると落ちる', () => {
    const fx = new FlashEffects();
    assert.equal(fx.live.length, 0, '何も spawn していないのに live がある');

    fx.spawnMuzzleFlash(source(0));
    assert.equal(fx.live.length, 1);
    const duration = fx.live[0]!.duration;
    assert.ok(duration > 0, '寿命が正でない');

    // 寿命の手前までは残り、超えた時点で落ちる。
    fx.update(duration * 0.5, duration * 0.5);
    assert.equal(fx.live.length, 1, '寿命の半分で消えている');
    assert.ok(Math.abs(fx.live[0]!.age - duration * 0.5) < 1e-9, 'age が進んでいない');

    fx.update(duration, duration * 1.5);
    assert.equal(fx.live.length, 0, '寿命を超えても残っている');
  });

  test('flash-effects: 生きているあいだは発生源の速度で運ばれる', () => {
    const fx = new FlashEffects();
    const speed = 2.5e3;
    fx.spawnBulletFlash(source(0, v3(1e6, 0, 0), v3(speed, 0, 0)));
    const start = fx.live[0]!.state.r.x;

    const dt = fx.live[0]!.duration * 0.25;
    fx.update(dt, dt);
    assert.equal(fx.live.length, 1);
    const moved = fx.live[0]!.state.r.x - start;
    assert.ok(Math.abs(moved - speed * dt) < 1e-6, `移流が速度に従っていない (${moved})`);
    // 速度そのものは運ばれても変わらない。
    assert.equal(fx.live[0]!.state.v.x, speed);
  });

  test('flash-effects: 静止した発生源では位置が動かない', () => {
    const fx = new FlashEffects();
    fx.spawnPlasmaFlash(source(0, v3(0, 3e6, 0)));
    const before = fx.live[0]!.state.r;
    const dt = fx.live[0]!.duration * 0.5;
    fx.update(dt, dt);
    assert.deepEqual(fx.live[0]!.state.r, before, '静止源なのに位置が動いた');
  });

  test('flash-effects: 重ねる種別は 2 枚、単発の種別は 1 枚を生む', () => {
    const overlaid = new FlashEffects();
    overlaid.spawnPlayerDestroyFlash(source(0));
    assert.equal(overlaid.live.length, 2, '撃破フラッシュが芯と外殻の 2 枚になっていない');
    assert.notEqual(overlaid.live[0]!.kind, overlaid.live[1]!.kind, '2 枚が同じ種別になっている');

    const single = new FlashEffects();
    single.spawnMuzzleFlash(source(0));
    assert.equal(single.live.length, 1);
  });

  test('flash-effects: 撃破フラッシュは模型の大きさで見た目の倍率が変わる', () => {
    const small = new FlashEffects();
    small.spawnEnemyDestroyFlash(source(0), 1);
    const large = new FlashEffects();
    large.spawnEnemyDestroyFlash(source(0), 4);
    assert.equal(large.live.length, small.live.length, '同じ種別で件数が違う');
    // 倍率そのものの値は調整値なので固定しない。大きい模型ほど大きく出ることだけを見る。
    for (const [i, big] of large.live.entries()) {
      assert.ok(big.sizeScale > small.live[i]!.sizeScale, '模型が大きいほうが小さく出ている');
    }
  });

  test('flash-effects: 寿命の違う 2 枚は、短いほうから先に落ちる', () => {
    const fx = new FlashEffects();
    fx.spawnGasPuff(source(0));
    assert.equal(fx.live.length, 2);
    const shortest = Math.min(...fx.live.map((e) => e.duration));
    const longest = Math.max(...fx.live.map((e) => e.duration));
    if (shortest === longest) return; // 同じ寿命なら落ちる順は決まらない。

    fx.update(shortest, shortest);
    assert.equal(fx.live.length, 1, '短いほうが落ちていない');
    assert.equal(fx.live[0]!.duration, longest);
  });
}
