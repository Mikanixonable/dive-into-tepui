// 円制限三体問題(CR3BP)の回転系力学と、周期軌道(ハロー/NRHO)を数値的に生成するための
// 微分修正法(differential correction, single shooting)。halo.ts の Richardson (1980) 3次
// 解析解は小〜中振幅でしか有効でないため、NRHO 級の大振幅まで真に周期的な軌道を得るには
// ここでの数値修正が要る。Richardson 解を初期推定として与え、振幅 az を連続的に大きくしながら
// (continuation)反復修正することで、解析解が発散する領域まで解を追跡する。
//
// 単位は CR3BP の標準無次元系: 長さは主天体・副天体間距離 r、時間は回転角速度の逆数 1/n。
// 原点は共通重心、+x は主天体→副天体方向、+z は公転面法線(回転軸)。質量比 mu = 副天体質量 /
// (主天体質量+副天体質量) で、主天体は x=-mu、副天体は x=1-mu に位置する。
// noUncheckedIndexedAccess 下で readonly number[] を固定長配列として読むための補助。
function at(a: readonly number[], i: number): number {
  return a[i] as number;
}

// 状態 [x,y,z,vx,vy,vz] に対する CR3BP 回転系での加速度(コリオリ・遠心力込み)。
function cr3bpDerivative(mu: number, s: readonly number[]): number[] {
  const x = at(s, 0);
  const y = at(s, 1);
  const z = at(s, 2);
  const vx = at(s, 3);
  const vy = at(s, 4);
  // r1・r2: 主天体(x=-mu)・副天体(x=1-mu)からの距離。
  const r1 = Math.sqrt((x + mu) ** 2 + y * y + z * z);
  const r2 = Math.sqrt((x - 1 + mu) ** 2 + y * y + z * z);
  const r1c = r1 * r1 * r1;
  const r2c = r2 * r2 * r2;
  const ax = x + 2 * vy - (1 - mu) * (x + mu) / r1c - mu * (x - 1 + mu) / r2c;
  const ay = y - 2 * vx - (1 - mu) * y / r1c - mu * y / r2c;
  const az = -(1 - mu) * z / r1c - mu * z / r2c;
  return [vx, vy, at(s, 5), ax, ay, az];
}

// 有効ポテンシャルの二階偏微分(ヘッシアン)。状態遷移行列(STM)の変分方程式 dPhi/dt = A*Phi の
// A = [[0,I],[Uxx,2Ω]] のうち左下ブロック Uxx を組み立てる(Ω は角速度行列の対称化前の3x3)。
function effectivePotentialHessian(mu: number, x: number, y: number, z: number): number[] {
  const r1sq = (x + mu) ** 2 + y * y + z * z;
  const r2sq = (x - 1 + mu) ** 2 + y * y + z * z;
  const r1 = Math.sqrt(r1sq);
  const r2 = Math.sqrt(r2sq);
  const r1c = r1sq * r1;
  const r2c = r2sq * r2;
  const r1f = r1c * r1sq;
  const r2f = r2c * r2sq;
  const m1 = 1 - mu;
  const dx1 = x + mu;
  const dx2 = x - 1 + mu;

  const uxx = 1 - m1 / r1c - mu / r2c + 3 * m1 * dx1 * dx1 / r1f + 3 * mu * dx2 * dx2 / r2f;
  const uyy = 1 - m1 / r1c - mu / r2c + 3 * m1 * y * y / r1f + 3 * mu * y * y / r2f;
  const uzz = -m1 / r1c - mu / r2c + 3 * m1 * z * z / r1f + 3 * mu * z * z / r2f;
  const uxy = 3 * m1 * dx1 * y / r1f + 3 * mu * dx2 * y / r2f;
  const uxz = 3 * m1 * dx1 * z / r1f + 3 * mu * dx2 * z / r2f;
  const uyz = 3 * m1 * y * z / r1f + 3 * mu * y * z / r2f;
  return [uxx, uxy, uxz, uxy, uyy, uyz, uxz, uyz, uzz];
}

// 状態6 + STM(6x6=36、行優先)を束ねた42次元の変分方程式右辺。
function cr3bpDerivativeWithStm(mu: number, y: readonly number[]): number[] {
  const s = y.slice(0, 6);
  const ds = cr3bpDerivative(mu, s);
  const u = effectivePotentialHessian(mu, at(s, 0), at(s, 1), at(s, 2));
  // A = [[0,I],[U,2Ω]]、2Ω = [[0,2,0],[-2,0,0],[0,0,0]]
  const dphi = new Array<number>(36);
  for (let col = 0; col < 6; col++) {
    const p = (row: number) => at(y, 6 + row * 6 + col);
    // 上3行: d(phi_row)/dt = phi_{row+3}
    dphi[0 * 6 + col] = p(3);
    dphi[1 * 6 + col] = p(4);
    dphi[2 * 6 + col] = p(5);
    // 下3行: d(phi_{row+3})/dt = U*[phi0..phi2] + 2Ω*[phi3..phi5]
    dphi[3 * 6 + col] = at(u, 0) * p(0) + at(u, 1) * p(1) + at(u, 2) * p(2) + 2 * p(4);
    dphi[4 * 6 + col] = at(u, 3) * p(0) + at(u, 4) * p(1) + at(u, 5) * p(2) - 2 * p(3);
    dphi[5 * 6 + col] = at(u, 6) * p(0) + at(u, 7) * p(1) + at(u, 8) * p(2);
  }
  return [...ds, ...dphi];
}

function rk4Step(deriv: (y: readonly number[]) => number[], y: readonly number[], dt: number): number[] {
  const k1 = deriv(y);
  const y2 = y.map((v, i) => v + (dt / 2) * at(k1, i));
  const k2 = deriv(y2);
  const y3 = y.map((v, i) => v + (dt / 2) * at(k2, i));
  const k3 = deriv(y3);
  const y4 = y.map((v, i) => v + dt * at(k3, i));
  const k4 = deriv(y4);
  return y.map((v, i) => v + (dt / 6) * (at(k1, i) + 2 * at(k2, i) + 2 * at(k3, i) + at(k4, i)));
}

const IDENTITY6: readonly number[] = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

// xz 面対称な周期軌道の初期条件 [x0,z0,vy0](y0=vx0=vz0=0 は固定)。
export interface HaloSeed {
  readonly x0: number;
  readonly z0: number;
  readonly vy0: number;
}

// 半周期 T のもとで x0(面内振幅)・z0(面外振幅)・vy0・halfPeriod が xz 面対称な
// 真に周期的な軌道を成す解。halfPeriod は y=0 面への次の対称交差までの無次元時間。
export interface CorrectedHalo extends HaloSeed {
  readonly halfPeriod: number;
}

const MAX_NEWTON_ITER = 40;
const NEWTON_TOL = 1e-11;
const STEPS_PER_HALF_PERIOD = 800;
const MAX_NEWTON_STEP = 0.02;

// 42次元状態(6状態+STM)を時刻 0 から T まで固定刻みで積分する。
function propagateWithStm(mu: number, y0: readonly number[], t: number): number[] {
  const dt = t / STEPS_PER_HALF_PERIOD;
  let y: readonly number[] = y0;
  for (let i = 0; i < STEPS_PER_HALF_PERIOD; i++) y = rk4Step((s) => cr3bpDerivativeWithStm(mu, s), y, dt);
  return [...y];
}

// z0 固定で、時刻 T(初期推定 halfPeriodGuess)における残差 [y(T),vx(T),vz(T)] が
// 0 になるよう Newton 法で修正し、真の周期軌道を返す。T 自体も未知数に含めて同時に解く —
// 積分中に y=0 通過を探してから (x0,vy0) だけを直す事象検出方式だと、共線点近傍の不安定性
// (初期推定のわずかな誤差が指数的に増幅する)により、探索窓の中で通過そのものを
// 見失うことがある。面内リアプノフ軌道(z0=0)は 3D ハロー族が分岐する族の出発点で、
// z 方向が恒等的に不変なので z 残差が退化する — その場合は振幅を決める x0 を継続法の
// 変数として固定し、(vy0,T) の 2x2 だけを解く。収束しなければ null。
export function correctHaloOrbit(mu: number, seed: HaloSeed, halfPeriodGuess: number): CorrectedHalo | null {
  let x0 = seed.x0;
  let vy0 = seed.vy0;
  const z0 = seed.z0;
  let t = halfPeriodGuess;
  // z0=0 の xz 面軌道は z 方向が恒等的に不変(z(t)≡0)なので、z 残差の行は常に 0=0 の
  // 冗長な式になり 3x3 は特異になる。その場合だけ (vy0,T) の 2x2 を解く(下記参照)。
  const planar = z0 === 0;

  for (let iter = 0; iter < MAX_NEWTON_ITER; iter++) {
    const y0 = [x0, 0, z0, 0, vy0, 0, ...IDENTITY6];
    const yf = propagateWithStm(mu, y0, t);

    const yPos = at(yf, 1);
    const vxf = at(yf, 3);
    const vzf = at(yf, 5);
    if (Math.abs(yPos) < NEWTON_TOL && Math.abs(vxf) < NEWTON_TOL && Math.abs(vzf) < NEWTON_TOL) {
      return { x0, z0, vy0, halfPeriod: t };
    }

    const phi = (row: number, col: number) => at(yf, 6 + row * 6 + col);
    let dx0: number;
    let dvy0: number;
    let dt: number;
    if (planar) {
      // 平面リアプノフ族は振幅1パラメータの族なので、振幅を決める x0 は継続法の変数として
      // 固定し、(vy0,T) の2つだけを解く — T を固定すると、真の半周期が振幅とともに動くぶん
      // Newton 法が意図した振幅から外れた(退化解を含む)別の族員へ収束してしまう。
      const finalAccel = cr3bpDerivative(mu, yf.slice(0, 6));
      const vyf = at(yf, 4);
      const axf = at(finalAccel, 3);
      const delta = solve2x2(
        [[phi(1, 4), vyf], [phi(3, 4), axf]],
        [-yPos, -vxf],
      );
      if (!delta) return null;
      dx0 = 0;
      dvy0 = at(delta, 0);
      dt = at(delta, 1);
    } else {
      const finalAccel = cr3bpDerivative(mu, yf.slice(0, 6));
      const vyf = at(yf, 4);
      const axf = at(finalAccel, 3);
      const azf = at(finalAccel, 5);
      // [y,vx,vz](T) を (x0,vy0,T) で Jacobi 化した3x3。T 列は状態の時間微分そのもの。
      const j = [
        [phi(1, 0), phi(1, 4), vyf],
        [phi(3, 0), phi(3, 4), axf],
        [phi(5, 0), phi(5, 4), azf],
      ];
      const delta = solve3x3(j, [-yPos, -vxf, -vzf]);
      if (!delta) return null;
      dx0 = at(delta, 0);
      dvy0 = at(delta, 1);
      dt = at(delta, 2);
    }
    if (!Number.isFinite(dx0) || !Number.isFinite(dvy0) || !Number.isFinite(dt)) return null;

    // 一歩の更新量を頭打ちにして、共線点近傍の強い非線形性による発散を防ぐ。
    const stepNorm = Math.hypot(dx0, dvy0, dt / t);
    const damp = Math.min(1, MAX_NEWTON_STEP / stepNorm);
    x0 += dx0 * damp;
    vy0 += dvy0 * damp;
    t += dt * damp;
    if (t <= 0) return null;
  }
  return null;
}

// 2x2 連立一次方程式 j*x=rhs を Cramer の公式で解く。特異なら null。
function solve2x2(j: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const a = at(j[0] as readonly number[], 0);
  const b = at(j[0] as readonly number[], 1);
  const c = at(j[1] as readonly number[], 0);
  const d = at(j[1] as readonly number[], 1);
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const r0 = at(rhs, 0);
  const r1 = at(rhs, 1);
  return [(r0 * d - b * r1) / det, (a * r1 - r0 * c) / det];
}

// 3x3 連立一次方程式 j*x=rhs を Cramer の公式で解く。特異なら null。
function solve3x3(j: readonly (readonly number[])[], rhs: readonly number[]): number[] | null {
  const a = at(j[0] as readonly number[], 0);
  const b = at(j[0] as readonly number[], 1);
  const c = at(j[0] as readonly number[], 2);
  const d = at(j[1] as readonly number[], 0);
  const e = at(j[1] as readonly number[], 1);
  const f = at(j[1] as readonly number[], 2);
  const g = at(j[2] as readonly number[], 0);
  const h = at(j[2] as readonly number[], 1);
  const k = at(j[2] as readonly number[], 2);
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;

  const [r0, r1, r2] = [at(rhs, 0), at(rhs, 1), at(rhs, 2)];
  const detX = r0 * (e * k - f * h) - b * (r1 * k - f * r2) + c * (r1 * h - e * r2);
  const detY = a * (r1 * k - f * r2) - r0 * (d * k - f * g) + c * (d * r2 - r1 * g);
  const detZ = a * (e * r2 - r1 * h) - b * (d * r2 - r1 * g) + r0 * (d * h - e * g);
  return [detX / det, detY / det, detZ / det];
}

// seed から az0(絶対値で継続変数とする z0)を targetZ0 まで小刻みに動かしながら correctHaloOrbit
// を繰り返す自然パラメータ連続法(continuation)。各ステップは直前の収束解を warm start にするので、
// Richardson 3次解の妥当域を超える大振幅(NRHO 級)まで解を追跡できる。収束しなければ null。
export function continueHaloOrbit(
  mu: number, seed: HaloSeed, halfPeriodGuess: number, targetZ0: number, maxStepZ0: number,
): CorrectedHalo | null {
  const startZ0 = seed.z0;
  const totalSpan = targetZ0 - startZ0;
  if (Math.abs(totalSpan) < 1e-15) return correctHaloOrbit(mu, seed, halfPeriodGuess);
  const steps = Math.max(1, Math.ceil(Math.abs(totalSpan) / maxStepZ0));

  let current: CorrectedHalo | null = { ...seed, halfPeriod: halfPeriodGuess };
  for (let i = 1; i <= steps; i++) {
    if (!current) return null;
    const z0 = startZ0 + (totalSpan * i) / steps;
    current = correctHaloOrbit(mu, { x0: current.x0, z0, vy0: current.vy0 }, current.halfPeriod);
  }
  return current;
}

// 修正済み軌道を t=0(y=0 面通過、x0,z0,vy0)から位相 phase(0..2π、周期にわたる無次元角)ぶん
// 伝播した状態(位置・速度、CR3BP 回転系無次元)を返す。
export function propagateHaloState(mu: number, orbit: CorrectedHalo, phase: number): number[] {
  const period = orbit.halfPeriod * 2;
  let target = (phase / (2 * Math.PI)) * period;
  target = ((target % period) + period) % period;
  const steps = Math.max(1, Math.round((target / period) * STEPS_PER_HALF_PERIOD * 2));
  const stepDt = steps > 0 ? target / steps : 0;
  let y: readonly number[] = [orbit.x0, 0, orbit.z0, 0, orbit.vy0, 0];
  for (let i = 0; i < steps; i++) y = rk4Step((s) => cr3bpDerivative(mu, s), y, stepDt);
  return [...y];
}
