// 実験10: 掃引接触判定(physics/sphere-contact)の解法別コスト。
// 弦・二次・三次を、棄却経路(箱で落ちる相手)と求根経路(表面を跨ぐ相手)に分けて測る。
// 配置は二体問題の RK4 から作り、実シミュレーション側の刻みガードは通さない。
import { KinematicState, kinematicState } from '../../src/physics/kinematic-state';
import { SweptMode, sweptSphereContact } from '../../src/physics/sphere-contact';
import { Attractor } from '../../src/physics/attractor';
import { stepDynamics } from '../../src/physics/dynamics';
import { MU_EARTH, R_EARTH_EQ } from '../../src/physics/solar-system';
import { Vec3, add, len, scale, v3 } from '../../src/physics/vec3';

const MODES: readonly SweptMode[] = ['linear', 'quadratic', 'cubic'];

// 原点に静止した地球。掃引の相手として使うので mu と radius だけが効く。
const EARTH: Attractor = {
  id: 'earth', mu: MU_EARTH, radius: R_EARTH_EQ,
  state: kinematicState(0, v3(), v3()), accel: v3(),
  degree2: null, atmosphere: null, isStar: false,
};

// 判定にかける1区間。両球の区間は共通で、長さは a 側の時刻差から取る。
interface Sweep {
  readonly label: string;
  readonly aStart: KinematicState;
  readonly aEnd: KinematicState;
  readonly bStart: KinematicState;
  readonly bEnd: KinematicState;
  readonly radiusSum: number;
}

// 地球の重力だけで dt 秒進める。空気抵抗・輻射圧・推力は掛けない。
function coast(state: KinematicState, dt: number): KinematicState {
  return stepDynamics(state, dt, [EARTH], null, 0, 0, null);
}

// 高度 alt の円軌道上の状態。x 軸上に置き、y 方向へ回る。
function circular(alt: number): KinematicState {
  const r = R_EARTH_EQ + alt;
  return kinematicState(0, v3(r, 0, 0), v3(0, Math.sqrt(MU_EARTH / r), 0));
}

// 静止した相手を、区間の両端で同じ状態として置く。
function fixed(r: Vec3, t0: number, t1: number): readonly [KinematicState, KinematicState] {
  return [kinematicState(t0, r, v3()), kinematicState(t1, r, v3())];
}

// 天体を相手にする区間。a 側を dt だけ自由落下させ、天体は原点に静止させる。
function againstEarth(label: string, start: KinematicState, dt: number, bodyR: Vec3, radius: number): Sweep {
  const aEnd = coast(start, dt);
  const [bStart, bEnd] = fixed(bodyR, start.t, aEnd.t);
  return { label, aStart: start, aEnd, bStart, bEnd, radiusSum: radius };
}

// 個体どうしの区間。基準の軌道から offset だけずらした相手を、同じ dt で自由落下させる。
function betweenEntities(label: string, dt: number, offset: Vec3, radiusSum: number): Sweep {
  const a = circular(413e3);
  const b = kinematicState(a.t, add(a.r, offset), scale(a.v, 1 + 2e-4));
  const aEnd = coast(a, dt);
  const bEnd = coast(b, dt);
  return { label, aStart: a, aEnd, bStart: b, bEnd, radiusSum };
}

// 表面を跨ぐ区間。円軌道から動径方向へ落として、dt の途中で地表へ届かせる。
function reentry(dt: number): Sweep {
  const c = circular(60e3);
  const start = kinematicState(0, c.r, add(c.v, v3(-4000, 0, 0)));
  return againstEarth('再突入(表面を跨ぐ)', start, dt, v3(), R_EARTH_EQ);
}

function sweeps(): readonly Sweep[] {
  const leo = circular(413e3);
  return [
    againstEarth('周回中の地球(触れない)', leo, 20, v3(), R_EARTH_EQ),
    againstEarth('遠方の天体(木星の距離)', leo, 20, v3(7.8e11, 0, 0), 7.1e7),
    reentry(20),
    betweenEntities('個体どうし・すれ違い', 20, v3(0, 0, 3000), 20),
    betweenEntities('個体どうし・接触', 20, v3(0, 0, 10), 20),
  ];
}

// 同じ区間を n 回解いて1回あたりの ns を返す。半径和を毎回わずかに動かして呼び出しを畳ませない。
function bench(sweep: Sweep, mode: SweptMode, n: number): number {
  let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const contact = sweptSphereContact(
      sweep.aStart, sweep.aEnd, sweep.bStart, sweep.bEnd, sweep.radiusSum * (1 + i * 1e-13), mode);
    sink += contact === null ? 0 : contact.crossing === null ? 1 : contact.crossing.toi;
  }
  const ms = performance.now() - t0;
  if (!Number.isFinite(sink)) throw new Error('sink が非有限');
  return (ms / n) * 1e6;
}

// 3モードの答えを並べる。コストを測る前に、同じ区間で同じ結論が出ることを確かめる。
function reportAnswers(list: readonly Sweep[]): void {
  console.log('配置 | 弦 | 二次 | 三次');
  console.log('--- | --- | --- | ---');
  for (const s of list) {
    const cells = MODES.map((mode) => {
      const c = sweptSphereContact(s.aStart, s.aEnd, s.bStart, s.bEnd, s.radiusSum, mode);
      if (c === null) return 'null';
      if (c.crossing === null) return c.startsInside ? '内側のまま' : '跨ぎなし';
      return `toi=${c.crossing.toi.toFixed(6)}`;
    });
    console.log(`${s.label} | ${cells.join(' | ')}`);
  }
}

export function run(): void {
  console.log('# 実験10: 掃引接触判定の解法別コスト\n');
  const list = sweeps();

  console.log('## 3モードの答え\n');
  reportAnswers(list);

  console.log('\n## 1回あたりのコスト [ns]\n');
  console.log('配置 | 弦 | 二次 | 三次 | 二次/弦 | 三次/弦 | 三次/二次');
  console.log('--- | --- | --- | --- | --- | --- | ---');
  const n = 2e6;
  for (const s of list) {
    for (const mode of MODES) bench(s, mode, 1e5); // ウォームアップ
    const [lin, quad, cub] = MODES.map((mode) => bench(s, mode, n));
    console.log(`${s.label} | ${lin!.toFixed(1)} | ${quad!.toFixed(1)} | ${cub!.toFixed(1)}`
      + ` | ${(quad! / lin!).toFixed(2)}× | ${(cub! / lin!).toFixed(2)}× | ${(cub! / quad!).toFixed(2)}×`);
  }

  console.log(`\n(n=${n.toExponential(0)} 回/セル、ウォームアップ 1e5 回)`);
  console.log(`地球の衝突球 ${(R_EARTH_EQ / 1e3).toFixed(0)} km、周回半径 ${((R_EARTH_EQ + 413e3) / 1e3).toFixed(0)} km`);
  console.log(`再突入配置の始点高度 ${((len(reentry(20).aStart.r) - R_EARTH_EQ) / 1e3).toFixed(0)} km`);
}

if (require.main === module) run();
