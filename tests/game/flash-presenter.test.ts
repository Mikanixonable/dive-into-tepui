// 出来事から起こす一時エフェクトの寿命と移流(game/flash-presenter.ts)の回帰テスト。期待値の
// 正本は「寿命が尽きたら消える」「発生源の速度で運ばれる」という不変条件で、duration や
// 大きさの調整値そのものは固定しない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { FlashPresenter } from '../../src/game/flash-presenter';
import { RunEventLog, type RunEventBody } from '../../src/game/run-events';
import { kinematicState } from '../../src/physics/kinematic-state';
import { v3 } from '../../src/math/vec3';

// 発生位置 r、発生源速度 v、その位置が表す時刻 t の閃光源。
function source(t: number, r = v3(1e6, 0, 0), v = v3(0, 0, 0)) {
  return kinematicState<'eci'>(t, r, v);
}

// 出来事を1件記録してから、表示時刻 displayTime で宣言を組む presenter を返す。
function presentOne(body: RunEventBody, displayTime: number): FlashPresenter {
  const presenter = new FlashPresenter();
  const log = new RunEventLog();
  log.record(body);
  presenter.present(log.recent, displayTime, false);
  return presenter;
}

export function register(): void {
  test('flash-presenter: 出来事から起きた閃光は live に並び、寿命が尽きると落ちる', () => {
    const presenter = new FlashPresenter();
    const log = new RunEventLog();
    presenter.present(log.recent, 0, false);
    assert.equal(presenter.live.length, 0, '何も起きていないのに live がある');

    log.record({ kind: 'gunFired', muzzleState: source(0) });
    presenter.present(log.recent, 0, false);
    assert.equal(presenter.live.length, 1);
    const duration = presenter.live[0]?.duration ?? 0;
    assert.ok(duration > 0, '寿命が正でない');

    // 寿命の手前までは残り、超えた時点で落ちる。記録は読んだ後に空になる。
    log.beginStep();
    presenter.present(log.recent, duration * 0.5, false);
    assert.equal(presenter.live.length, 1, '寿命の半分で消えている');
    assert.ok(
      Math.abs((presenter.live[0]?.age ?? 0) - duration * 0.5) < 1e-9, 'age が進んでいない');

    presenter.present(log.recent, duration * 1.5, false);
    assert.equal(presenter.live.length, 0, '寿命を超えても残っている');
  });

  test('flash-presenter: 生きているあいだは発生源の速度で運ばれる', () => {
    const speed = 2.5e3;
    const presenter = presentOne(
      { kind: 'enemyStruckByBullet', bullet: 'normal', state: source(0, v3(1e6, 0, 0), v3(speed, 0, 0)) },
      0,
    );
    const start = presenter.live[0]?.state.r.x ?? 0;
    const dt = (presenter.live[0]?.duration ?? 0) * 0.25;

    presenter.present([], dt, false);
    const moved = (presenter.live[0]?.state.r.x ?? 0) - start;
    assert.ok(Math.abs(moved - speed * dt) < 1e-6, `移流が速度に従っていない (${moved})`);
    // 速度そのものは運ばれても変わらない。
    assert.equal(presenter.live[0]?.state.v.x, speed);
  });

  test('flash-presenter: 静止した発生源では位置が動かない', () => {
    const presenter = presentOne(
      { kind: 'enemyStruckByBullet', bullet: 'plasma', state: source(0, v3(0, 3e6, 0)) }, 0);
    const before = presenter.live[0]?.state.r;
    presenter.present([], (presenter.live[0]?.duration ?? 0) * 0.5, false);
    assert.deepEqual(presenter.live[0]?.state.r, before, '静止源なのに位置が動いた');
  });

  test('flash-presenter: 重ねる種別は 2 枚、単発の種別は 1 枚を生む', () => {
    const overlaid = presentOne({ kind: 'shipExploded', state: source(0), modelScale: 1 }, 0);
    assert.equal(overlaid.live.length, 2, '撃破フラッシュが芯と外殻の 2 枚になっていない');
    assert.notEqual(
      overlaid.live[0]?.color, overlaid.live[1]?.color, '2 枚が同じ見え方になっている');

    const single = presentOne({ kind: 'gunFired', muzzleState: source(0) }, 0);
    assert.equal(single.live.length, 1);
  });

  test('flash-presenter: 撃破フラッシュは模型の大きさで見た目の倍率が変わる', () => {
    const small = presentOne({ kind: 'shipExploded', state: source(0), modelScale: 1 }, 0);
    const large = presentOne({ kind: 'shipExploded', state: source(0), modelScale: 4 }, 0);
    assert.equal(large.live.length, small.live.length, '同じ種別で件数が違う');
    // 倍率そのものの値は調整値なので固定しない。大きい模型ほど大きく出ることだけを見る。
    for (const [i, big] of large.live.entries()) {
      assert.ok(
        big.size1 > (small.live[i]?.size1 ?? Infinity), '模型が大きいほうが小さく出ている');
    }
  });

  test('flash-presenter: 寿命の違う 2 枚は、短いほうから先に落ちる', () => {
    const presenter = presentOne({ kind: 'shipDamagedByContact', state: source(0) }, 0);
    assert.equal(presenter.live.length, 2);
    const shortest = Math.min(...presenter.live.map((e) => e.duration));
    const longest = Math.max(...presenter.live.map((e) => e.duration));
    if (shortest === longest) return; // 同じ寿命なら落ちる順は決まらない。

    presenter.present([], shortest, false);
    assert.equal(presenter.live.length, 1, '短いほうが落ちていない');
    assert.equal(presenter.live[0]?.duration, longest);
  });

  test('flash-presenter: 同じ出来事を二度読んでも閃光は増えない', () => {
    const presenter = new FlashPresenter();
    const log = new RunEventLog();
    log.record({ kind: 'gunFired', muzzleState: source(0) });
    presenter.present(log.recent, 0, false);
    presenter.present(log.recent, 0, false);
    assert.equal(presenter.live.length, 1, '同じ出来事から二度閃光が出ている');
  });

  test('flash-presenter: 照準ズーム中は、それで減光する種別だけが暗くなる', () => {
    // マズルフラッシュはズームで減光し、着弾フラッシュは減光しない。
    const brightness = (body: RunEventBody, zoomed: boolean): number => {
      const presenter = new FlashPresenter();
      const log = new RunEventLog();
      log.record(body);
      presenter.present(log.recent, 0, zoomed);
      return presenter.live[0]?.brightness ?? 0;
    };
    const muzzle: RunEventBody = { kind: 'gunFired', muzzleState: source(0) };
    const impact: RunEventBody = { kind: 'enemyStruckByBullet', bullet: 'normal', state: source(0) };
    assert.ok(brightness(muzzle, true) < brightness(muzzle, false), 'ズーム中にマズルフラッシュが減光していない');
    assert.equal(brightness(impact, true), brightness(impact, false), 'ズームで減光しない種別まで暗くなった');
  });

  test('flash-presenter: 表示時刻が止まっている間は閃光も止まる', () => {
    const presenter = presentOne({ kind: 'gunFired', muzzleState: source(0) }, 0);
    const duration = presenter.live[0]?.duration ?? 0;
    presenter.present([], duration * 0.5, false);
    const frozen = presenter.live[0]?.age;
    // 表示時刻が同じフレームを何度通しても、経過も件数も変わらない。
    presenter.present([], duration * 0.5, false);
    assert.equal(presenter.live.length, 1);
    assert.equal(presenter.live[0]?.age, frozen);
  });
}
