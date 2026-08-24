// 実験13: 物体どうしの剛体接触を高いワープでも解いた場合の費用と、その刻み幅で判定が意味を
// 持つかどうか。倍率を ×1 から ×131072 まで振り、1フレームぶんを実ゲームと同じ substep 幅で
// 積みながら、(1) 接触グリッドのセル一辺、(2) 27近傍から集まる候補ペア数と総当たりに対する
// 削減比、(3) 候補ペアを resolveSphereCollision に通した所要、(4) その substep 幅における
// 三次掃引の乖離(R* − 真の最接近距離、exp11 と同じ測り方)を出す。
//
// 母集団は collides=true の個体だけで組む — exp12 が使った debug-load の破片は
// kind:'fragment' で collides=false なので、個体どうしの接触の参加者にならない。
// 参加者の半径と質量は原本の値をそのまま置く(下の population のコメントに出どころを書いた)。
import { dragTakesFullAirspeed } from '../../src/game/simulation/time-step';
import { CelestialBody, nearestAtmosphereBody } from '../../src/physics/celestial-body';
import { resolveSphereCollision } from '../../src/physics/collision-response';
import { stepDynamics } from '../../src/physics/dynamics';
import { firstSurfaceContact } from '../../src/physics/surface-contact';
import { Ephemeris } from '../../src/physics/ephemeris';
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { mulberry32 } from '../../src/physics/random';
import { SpatialGrid } from '../../src/physics/spatial-grid';
import { Vec3, add, cross, len, norm, scale, sub, v3 } from '../../src/physics/vec3';
import * as C from '../../src/game/const';
import { simulationMaxStep } from '../../src/game/simulation/time-step';
import { SHIP_BCINV, buildEphemeris, initialLeoState } from './common';
import { EARTH, Sweep, circular, companion, freeFall, sweepOf } from './sphere-contact-sweeps';
import { flipRadius, minDistanceOf } from './sphere-contact-reference';

const FRAME_DT = 1 / 60; // 60 fps を想定した実フレーム時間 [s]
const REPEATS = 3; // 各測定の反復数。GC とスケジューリングは上振れにしか出ないので最小値を採る
// 放熱板の折りの接触半径。原本は RADIATOR_SEGMENT_LENGTH / 2 で、その定数は
// src/render/ships.ts の (2.3 * 4) / 6 — three を引き込むので値だけを写す。
const RADIATOR_FOLD_RADIUS = (2.3 * 4) / 6 / 2;

// 接触の参加者。GameEntity の代わりに、接触が読む属性だけを持つ。
interface Participant {
  readonly radius: number;
  readonly invMass: number;
  readonly bcInv: number;
  readonly owner: number; // 取り付け先の参加者番号(-1 は独立)。同じ番号どうしは接触しない
  prev: KinematicState;
  state: KinematicState;
}

const num = (x: number): string => x.toLocaleString('en-US');

// fn を1回ウォームアップしてから REPEATS 回走らせ、cost が最小だった結果を返す。
function fastest<T>(fn: () => T, cost: (r: T) => number): T {
  fn();
  let best = fn();
  for (let i = 2; i < REPEATS; i++) {
    const r = fn();
    if (cost(r) < cost(best)) best = r;
  }
  return best;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): void {
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const row of rows) console.log(row.join(' | '));
}

function participant(
  state: KinematicState, radius: number, mass: number, bcInv: number, owner = -1,
): Participant {
  return { radius, invMass: 1 / mass, bcInv, owner, prev: state, state };
}

// 基準状態から offset だけずらし、速度を relV だけ加えた状態。
function nearby(base: KinematicState, offset: Vec3, relV: Vec3): KinematicState {
  return kinematicState(base.t, add(base.r, offset), add(base.v, relV));
}

// 中心から距離 dist の球面上の一様ランダムな向きのオフセット。rand を2回消費する。
function shellOffset(rand: () => number, dist: number): Vec3 {
  const z = 2 * rand() - 1, phi = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
  return v3(dist * s * Math.cos(phi), dist * s * Math.sin(phi), dist * z);
}

// 艦とその周りの参加者。半径・質量は原本のとおり:
//   自機 PLAYER_HULL_RADIUS / PLAYER_MASS、敵機 ENEMY_RADIUS / 10000(enemy.ts)、
//   薬莢 0.2 m(effects-system.ts の spawnCasing)/ 質量 0、
//   放熱板の折り・ベルトの節 質量 5(radiator.ts / belt-physics.ts)、
//   弾 BULLET_RADIUS / BULLET_MASS。
// 敵機の半径は原本では描画メッシュのバウンディング球で置き換わる(enemy.ts)が、ここでは
// 当たり判定の公称値 ENEMY_RADIUS を使う — セル一辺を大きい側へ見積もる。
// spread は敵機を別高度・別傾斜へ移し、薬莢を軌道1周ぶんに散らし、飛翔中の弾を載せた集団。
function population(kind: 'dense' | 'spread'): readonly Participant[] {
  const rand = mulberry32(13);
  const ship = initialLeoState();
  const out: Participant[] = [participant(ship, C.PLAYER_HULL_RADIUS, C.PLAYER_MASS, SHIP_BCINV)];
  const alongTrack = norm(ship.v);
  const outward = norm(ship.r);
  const crossTrack = norm(cross(ship.r, ship.v));

  for (let i = 0; i < 3; i++) {
    // 密集は編隊(数 km 以内・相対 20 m/s)、ばらけは高度 ±50 km・傾斜 ±0.3° 相当の別軌道。
    const state = kind === 'dense'
      ? nearby(ship, shellOffset(rand, 2e3 * (i + 1)), scale(alongTrack, 20 * (rand() - 0.5)))
      : nearby(ship,
        add(scale(outward, 50e3 * (i - 1)), scale(crossTrack, 300e3 * (rand() - 0.5))),
        scale(crossTrack, 40 * (i - 1)));
    out.push(participant(state, C.ENEMY_RADIUS, 10000, SHIP_BCINV));
  }
  for (let i = 0; i < C.MAX_CASINGS; i++) {
    // 排莢は側方への低速散布。密集は直近の射撃ぶん、ばらけは撃ち続けた末に軌道へ散った状態。
    const spread = kind === 'dense' ? 200 : 60e3;
    out.push(participant(
      nearby(ship, shellOffset(rand, spread * rand()), scale(shellOffset(rand, 1), 2 * rand())),
      0.2, 0, C.SMALL_DEBRIS_BCINV));
  }
  for (let i = 0; i < 2 * C.RADIATOR_FOLD_COUNT; i++) {
    out.push(participant(nearby(ship, shellOffset(rand, 8), v3()),
      RADIATOR_FOLD_RADIUS, 5, SHIP_BCINV, 0));
  }
  for (let i = 0; i < C.BELT_MAX_VISIBLE; i++) {
    out.push(participant(nearby(ship, shellOffset(rand, 6), v3()), 0.8, 5, SHIP_BCINV, 0));
  }
  if (kind === 'spread') {
    for (let i = 0; i < C.MAX_BULLETS; i++) {
      out.push(participant(
        nearby(ship, shellOffset(rand, 15e3 * rand()), scale(shellOffset(rand, 1), C.MUZZLE_SPEED)),
        C.BULLET_RADIUS, C.BULLET_MASS, C.BULLET_BCINV));
    }
  }
  return out;
}

// substep 1つぶんの天体窓。中点で1回だけ引くのは Simulator.substep と同じで、積分にも除去にも
// 同じものを使う。
interface Windows {
  readonly sources: readonly CelestialBody[];
  readonly occluders: readonly CelestialBody[];
  readonly air: readonly CelestialBody[];
}

function windowsAt(ephemeris: Ephemeris, tMid: number): Windows {
  return {
    sources: ephemeris.gravityAttractorsAt(tMid),
    occluders: ephemeris.celestialBodiesAt(tMid),
    air: ephemeris.atmosphereCelestialBodiesAt(tMid),
  };
}

function stepAll(all: readonly Participant[], w: Windows, dt: number): void {
  for (const p of all) {
    p.prev = p.state;
    p.state = stepDynamics(
      p.state, dt, w.sources, w.occluders, nearestAtmosphereBody(p.state.r, w.air), p.bcInv, 0, null);
  }
}

// 表面へ到達した個体と、抗力を積めなくなった個体を、実ゲームと同じ判定で以後から外す。
// 外さないと、地球の中へ入った弾が中心の近くで発散し、その変位がセル一辺を通じて全参加者へ
// 伝播して測定そのものを壊す(exp12 が同じ理由で同じ除去を入れている)。
function survivors(all: readonly Participant[], w: Windows, dt: number): readonly Participant[] {
  return all.filter((p) => firstSurfaceContact(p.prev, p.state, p.radius, w.occluders) === null
    && !dragTakesFullAirspeed(p.state, p.bcInv, w.air, dt));
}

// 27近傍グリッドのセル一辺 [m]。entity-contact-physics.ts の contactCellSize の式の複製 —
// 原本は GameEntity 経由で three/DOM を引き込むため、tests/perf の tsconfig ではコンパイル
// できない。参加者集合に共通する変位(平均 Δ̄)を差し引いた到達量 半径+|Δ−Δ̄| の最大値の2倍。
function contactCellSize(all: readonly Participant[]): number {
  let mean = v3();
  for (const p of all) mean = add(mean, sub(p.state.r, p.prev.r));
  mean = scale(mean, 1 / all.length);
  let maxReach = 0;
  for (const p of all) {
    const reach = p.radius + len(sub(sub(p.state.r, p.prev.r), mean));
    if (reach > maxReach) maxReach = reach;
  }
  return 2 * maxReach || C.CONTACT_GRID_CELL_SIZE_FLOOR;
}

interface SubstepCost {
  readonly cellSize: number;
  readonly pairs: number;    // 27近傍から集まり、contactsWith を通った候補ペア数
  readonly contacts: number; // そのうち実際に接触していたもの
  readonly ms: number;       // グリッド構築・近傍列挙・resolveSphereCollision の合計
}

// 1 substep ぶんの接触解決を、実際に解かずに列挙と幾何の計算まで通した費用。反発の書き戻しと
// TOI 順の再評価は入れない — 測るのはゲートを外したときに必ず掛かる費用の側で、実際に接触が
// 起きた回数ぶんの解決はその上に乗る(接触した件数を contacts に併記する)。
function substepCost(all: readonly Participant[]): SubstepCost {
  const t0 = performance.now();
  const cellSize = contactCellSize(all);
  const grid = new SpatialGrid<number>(cellSize);
  for (let i = 0; i < all.length; i++) grid.insert(i, all[i]!.state.r);
  const neighbors: number[] = [];
  let pairs = 0, contacts = 0;
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    for (const j of grid.neighborsInto(a.state.r, neighbors)) {
      if (j <= i) continue;
      const b = all[j]!;
      if (a.owner !== -1 && a.owner === b.owner) continue; // 同じ艦に取り付いた代理どうし
      pairs++;
      const response = resolveSphereCollision(a, b, C.CONTACT_RESTITUTION, a.prev, b.prev);
      if (response !== null) contacts++;
    }
  }
  return { cellSize, pairs, contacts, ms: performance.now() - t0 };
}

interface FrameCost {
  readonly substeps: number;
  readonly maxCellSize: number;
  readonly pairs: number;
  readonly contacts: number;
  readonly ms: number;
  readonly lost: number; // 表面到達・焼失で外れた参加者
}

// 1フレームぶん(simDt)を substep へ割って積み、各 substep で接触解決の費用を測る。
// 最後の1歩だけを端数へ縮めるのは Simulator.advance と同じ。
function frameCost(ephemeris: Ephemeris, kind: 'dense' | 'spread', simDt: number): FrameCost {
  const initial = population(kind);
  let alive: readonly Participant[] = initial;
  const maxStep = simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
  const end = initial[0]!.state.t + simDt;
  let t = initial[0]!.state.t;
  let substeps = 0, maxCellSize = 0, pairs = 0, contacts = 0, ms = 0;
  while (end - t > 1e-9) {
    const dt = Math.min(maxStep, end - t);
    const w = windowsAt(ephemeris, t + dt / 2);
    stepAll(alive, w, dt);
    alive = survivors(alive, w, dt);
    const cost = substepCost(alive);
    substeps++;
    maxCellSize = Math.max(maxCellSize, cost.cellSize);
    pairs += cost.pairs;
    contacts += cost.contacts;
    ms += cost.ms;
    t += dt;
  }
  return { substeps, maxCellSize, pairs, contacts, ms, lost: initial.length - alive.length };
}

function reportPopulation(ephemeris: Ephemeris, kind: 'dense' | 'spread'): void {
  const all = population(kind);
  const n = all.length;
  const bruteForcePairs = (n * (n - 1)) / 2;
  // 変位がゼロでも、セル一辺は最大半径の2倍を下回らない — 大きい参加者が1体いるだけで、
  // 小さい参加者どうしの絞り込みまで効かなくなる。
  const cellFloor = 2 * Math.max(...all.map((q) => q.radius));
  console.log(`\n### ${kind === 'dense' ? '同一軌道に密集' : '高度と傾斜角がばらけた集団'}`
    + `(参加者 ${n} 体、総当たり ${num(bruteForcePairs)} ペア/substep)\n`);
  table(
    ['倍率', 'substep 幅 [s]', 'substep/フレーム', 'セル一辺 [m]',
      '候補ペア/substep', '削減比', '接触/フレーム', '失われた参加者', '費用 [ms/フレーム]'],
    C.SIM_SPEED_LEVELS.map((warp) => {
      const simDt = FRAME_DT * warp;
      const maxStep = simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT);
      const f = fastest(() => frameCost(ephemeris, kind, simDt), (r) => r.ms);
      const perSubstep = f.pairs / f.substeps;
      return [
        `×${num(warp)}`,
        Math.min(maxStep, simDt).toFixed(2),
        `${f.substeps}`,
        f.maxCellSize.toFixed(1),
        num(Math.round(perSubstep)),
        `${(bruteForcePairs / Math.max(1, perSubstep)).toFixed(1)}×`,
        num(f.contacts),
        num(f.lost),
        f.ms.toFixed(2),
      ];
    }),
  );
  console.log(`
最大半径 ${Math.max(...all.map((q) => q.radius))} m(敵機)により、セル一辺は変位がゼロでも ${cellFloor} m を下回らない。`);
}

// 相対速度 relSpeed で交差する2体の、区間 dt ぶんの掃引。最接近が区間の中央に来るように相手を
// 戻して置き、そこでの最接近距離を missDistance にする。
function crossingSweep(label: string, dt: number, relSpeed: number, missDistance: number): Sweep {
  const ship = circular(EARTH, 413e3);
  const dir = norm(cross(ship.r, ship.v)); // 軌道面に垂直な向きへ交差させる
  const miss = scale(norm(ship.v), missDistance);
  const relV = scale(dir, relSpeed);
  const other = companion(ship, add(scale(relV, -dt / 2), miss), relV);
  return sweepOf(label, ship, other, dt, freeFall(EARTH), freeFall(EARTH), missDistance);
}

function fmt(m: number): string {
  const a = Math.abs(m);
  if (a >= 1e3) return `${(m / 1e3).toFixed(1)} km`;
  if (a >= 1) return `${m.toFixed(2)} m`;
  if (a >= 1e-3) return `${(m * 1e3).toFixed(1)} mm`;
  return `${(m * 1e6).toFixed(1)} µm`;
}

// 相対速度の3通り。排莢(低速)・敵機とのすれ違い・弾の命中で、substep 幅の効き方が変わる。
const CROSSINGS: readonly (readonly [string, number])[] = [
  ['薬莢 3 m/s', 3], ['敵機 200 m/s', 200], [`弾 ${C.MUZZLE_SPEED} m/s`, C.MUZZLE_SPEED],
];
const MISS_DISTANCE = 10; // 真の最接近距離 [m]。判定が反転する半径和をこの周りで探す

function reportAccuracy(): void {
  console.log('\n## (4) その substep 幅で三次掃引がどれだけずれるか\n');
  console.log('R\\* は「接触した」へ答えが反転する半径和。真値との差が正なら偽陰性側(すり抜け)、'
    + `負なら偽陽性側。真の最接近距離は ${MISS_DISTANCE} m。\n`);
  table(
    ['倍率', 'substep 幅 [s]', ...CROSSINGS.map(([label]) => `${label} の R\\* − 真値`)],
    C.SIM_SPEED_LEVELS.map((warp) => {
      const simDt = FRAME_DT * warp;
      const dt = Math.min(simulationMaxStep(simDt, C.SUBSTEP_MAX_DT, C.SUBSTEP_MAX_COUNT), simDt);
      return [`×${num(warp)}`, dt.toFixed(2), ...CROSSINGS.map(([label, relSpeed]) => {
        const sweep = crossingSweep(label, dt, relSpeed, MISS_DISTANCE);
        const flip = flipRadius(sweep, '三次');
        return flip === null
          ? `測定不能(近似の最接近 ${fmt(minDistanceOf(sweep, '三次'))})`
          : fmt(flip - sweep.trueMin);
      })];
    }),
  );
}

export function run(): void {
  console.log('# 実験13: 物体どうしの接触をワープ倍率で振ったときの費用と判定の意味\n');
  const ephemeris = buildEphemeris();
  console.log('## (1)(2)(3) 絞り込みと接触判定の費用');
  reportPopulation(ephemeris, 'dense');
  reportPopulation(ephemeris, 'spread');
  reportAccuracy();
}

if (require.main === module) run();
