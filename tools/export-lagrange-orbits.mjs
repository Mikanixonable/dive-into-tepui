// ラグランジュ点まわりの周期軌道族(ハロー軌道・DRO)を CR3BP の微分修正と自然パラメータ
// 継続で解き、src/assets/orbits/lagrange-orbits.json へ焼き出すツール。
// マップのガイド線は実行時にこの表を補間して描くので、ここが唯一の生成元になる。
//
// 実行: node tools/export-lagrange-orbits.mjs
//
// 同じ入力からは常に同じ出力を書く(時刻・環境に依存する値を含めない)。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhysicsModules } from './compile-physics.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(repoRoot, 'src', 'assets', 'orbits', 'lagrange-orbits.json');

// 族に沿って保存するメンバー数と、1メンバーあたりの点数。
const HALO_MEMBERS = 21;
const DRO_MEMBERS = 20;
const POINTS_PER_ORBIT = 72;
const COORD_DIGITS = 5;
// 重心からこれ以上広がった軌道はガイド線として読めないので、そこを族末端とする。
const FAMILY_EXTENT_LIMIT = 2.5;
// 族を辿るときと、書き出すメンバーを解き直すときの積分の刻み数。
const CHAIN_STEPS = 3000;
const REFINE_STEPS = 40000;
// 周期軌道として認める閉合残差(軌道の広がりに対する比)。これを超えたところが族末端。
const CLOSURE_TOLERANCE = 1e-3;
// 鎖の隣り合うメンバーの形の変化を、軌道の広がりに対するこの比の範囲に収める。
// 上を超えたら刻みを詰め、下を割ったら伸ばして、族に沿って一様な密度の鎖にする。
const SHAPE_STEP_LIMIT = 0.05;

const physics = loadPhysicsModules(['cr3bp', 'halo', 'ephemeris', 'solar-system']);
const { cr3bp, halo, ephemeris: ephemerisModule, solarSystem } = physics;

// レジストリの実質量・実距離から系ごとの無次元パラメータを組む。
function systemsFromRegistry() {
  const eph = new ephemerisModule.Ephemeris(solarSystem.SOLAR_SYSTEM, 'earth', ephemerisModule.EPOCH_T_OFFSET);
  return [
    { key: 'sun-earth', primary: 'sun', secondary: 'earth' },
    { key: 'earth-moon', primary: 'earth', secondary: 'moon' },
  ].map(({ key, primary, secondary }) => {
    const primaryDef = solarSystem.bodyDef(solarSystem.SOLAR_SYSTEM, primary);
    const secondaryDef = solarSystem.bodyDef(solarSystem.SOLAR_SYSTEM, secondary);
    const p = eph.positionOf(primary, 0);
    const s = eph.positionOf(secondary, 0);
    const separation = Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z);
    return {
      key,
      mu: secondaryDef.mu / (primaryDef.mu + secondaryDef.mu),
      secondaryRadius: secondaryDef.radius / separation,
    };
  });
}

// Richardson 三次近似から、xz 面を横切る瞬間の CR3BP 状態と周期の見積りを作る。
function richardsonSeed(mu, point, az) {
  const params = halo.collinearParams(point, mu);
  const c = halo.richardsonCoefficients(params);
  const ax = halo.richardsonAmplitudeX(c, az);
  if (!Number.isFinite(ax)) return null;
  const period = halo.richardsonPeriod(c, ax, az);
  // 面内 y 方向の速度だけが 0 でないので、位相を微小に進めた点との差から取る。
  const dtau = 1e-6;
  const at = (tau) => halo.collinearLocalToBarycentric(params, halo.richardsonPoint(c, ax, az, true, tau));
  const p0 = at(0);
  const vy = ((at(dtau)[1] - p0[1]) / dtau) * (2 * Math.PI / period);
  return { state: [p0[0], 0, p0[2], 0, vy, 0], period };
}

// 軌道1周のうち副天体に最も近づく距離と、重心から最も離れる距離(いずれも無次元)。
function orbitExtent(mu, points) {
  return {
    closest: Math.min(...points.map((p) => Math.hypot(p[0] - 1 + mu, p[1], p[2]))),
    farthest: Math.max(...points.map((p) => Math.hypot(p[0], p[1], p[2]))),
  };
}

// 族を辿っている途中で別の解へ飛び移っていないか。周期の跳びと、刻みに対して不相応な
// 状態の移動を弾く。
function continuesFamily(prev, next, step) {
  const jump = Math.hypot(next.state[0] - prev.state[0], next.state[2] - prev.state[2]);
  return Math.abs(next.period - prev.period) < 0.15 * prev.period && jump < 5 * step;
}

// ハロー族を分岐直後から族末端まで継続する。前後のメンバーの差から族の接線方向を取り、
// 変化の大きい成分を固定パラメータに選び直すことで、x0・z0 どちらの折り返しも越える。
// 族末端は副天体の表面に近点が達したところか、軌道が系の外へ広がりすぎたところ。
function continueHaloFamily(mu, point, secondaryRadius) {
  const seed = richardsonSeed(mu, point, 0.05);
  if (seed === null) return [];
  const first = cr3bp.correctHaloOrbit(mu, seed.state, 'z', seed.period / 2, CHAIN_STEPS);
  if (first === null) return [];

  const scale = halo.collinearParams(point, mu).gamma;
  const chain = [{ ...first, points: cr3bp.sampleOrbitByArcLength(mu, first.state, first.period, 120) }];
  let direction = [0, 1];
  let step = 0.02 * Math.abs(first.state[2]);
  while (chain.length < 1500 && step > 1e-5 * scale) {
    const prev = chain[chain.length - 1];
    const fixed = Math.abs(direction[0]) > Math.abs(direction[1]) ? 'x' : 'z';
    const guess = [
      prev.state[0] + step * direction[0], 0, prev.state[2] + step * direction[1], 0, prev.state[4], 0,
    ];
    const next = cr3bp.correctHaloOrbit(mu, guess, fixed, prev.period / 2, CHAIN_STEPS);
    if (next === null || !continuesFamily(prev, next, step)) { step /= 2; continue; }
    const points = cr3bp.sampleOrbitByArcLength(mu, next.state, next.period, 120);
    const member = { ...next, points };
    // 形が一気に変わる区間では刻みを詰める。鎖の粗さがそのまま書き出すメンバーの飛びになる。
    const change = shapeDistance(prev, member) / orbitSize(prev);
    if (change > SHAPE_STEP_LIMIT) { step /= 2; continue; }
    chain.push(member);
    if (change < SHAPE_STEP_LIMIT / 3) step *= 1.25;
    const extent = orbitExtent(mu, points);
    if (extent.closest < secondaryRadius || extent.farthest > FAMILY_EXTENT_LIMIT) break;
    const dx = next.state[0] - prev.state[0];
    const dz = next.state[2] - prev.state[2];
    const norm = Math.hypot(dx, dz);
    if (norm > 0) direction = [dx / norm, dz / norm];
  }
  return chain;
}

// 軌道自身の広がり(点列の中心から最も離れた点までの距離)。閉合残差や形の変化を
// 測る物差しになるので、系の原点ではなく軌道自身を基準に取る。
function orbitSize(member) {
  const n = member.points.length;
  const center = [0, 1, 2].map((j) => member.points.reduce((sum, p) => sum + p[j], 0) / n);
  return Math.max(...member.points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2])));
}

// 隣り合う2メンバーの形の隔たり(対応する点どうしの最大距離)。
function shapeDistance(a, b) {
  return Math.max(...a.points.map((p, i) => Math.hypot(
    b.points[i][0] - p[0], b.points[i][1] - p[1], b.points[i][2] - p[2],
  )));
}

// 鎖から、形の変化が等間隔になるように count 個を選ぶ。状態量ではなく形を距離に取ることで、
// 分岐直後に形が速く変わる区間でもガイド線の並びが飛ばない。
function pickAlongFamily(chain, count) {
  if (chain.length < count) return chain;
  const cumulative = [0];
  for (let i = 1; i < chain.length; i++) {
    cumulative.push(cumulative[i - 1] + shapeDistance(chain[i - 1], chain[i]));
  }
  const total = cumulative[cumulative.length - 1];
  const picked = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (cursor < cumulative.length - 1 && cumulative[cursor + 1] < target) cursor++;
    // 形が急に変わる区間では複数の目標が同じメンバーに落ちるので、必ず次へ送る。
    picked.push(chain[Math.min(Math.max(cursor, i === 0 ? 0 : picked.length), chain.length - 1)]);
  }
  return picked;
}

function round(value) {
  return Number(value.toFixed(COORD_DIGITS));
}

// 1周期積分して戻ってくるまでの隔たりを、軌道の広がりで割った値。
function closureResidual(mu, member) {
  const end = cr3bp.cr3bpPropagate(mu, member.state, member.period, REFINE_STEPS);
  const gap = Math.hypot(end[0] - member.state[0], end[1], end[2] - member.state[2]);
  return gap / orbitSize(member);
}

// 族を辿るときの刻み数では、副天体へ深く落ちるメンバーの周期軌道条件が粗いままになる。
// 書き出す前に高い分解能で解き直し、同じ軌道のまま閉合が改善したときだけ差し替える。
function refine(mu, member) {
  let best = member;
  let bestResidual = closureResidual(mu, member);
  for (const fixed of ['z', 'x']) {
    const refined = cr3bp.correctHaloOrbit(mu, member.state, fixed, member.period / 2, REFINE_STEPS);
    if (refined === null) continue;
    const points = cr3bp.sampleOrbitByArcLength(mu, refined.state, refined.period, 120);
    const candidate = { ...refined, points };
    const residual = closureResidual(mu, candidate);
    if (shapeDistance(member, candidate) < 0.05 * orbitSize(member) && residual < bestResidual) {
      best = candidate;
      bestResidual = residual;
    }
  }
  return best;
}

// 高い分解能で見ても周期軌道と言える範囲まで鎖を切り詰める。最初に閉合が崩れたところが
// 族末端で、そこから先は継続が別の解へ滑っている。
function trimToClosedMembers(mu, chain) {
  const index = chain.findIndex((member) => closureResidual(mu, member) > CLOSURE_TOLERANCE);
  return index < 0 ? chain : chain.slice(0, index);
}

// 選んだメンバー列を、L点局所座標(gamma 単位)の弧長等間隔な点列へ落とす。
// CR3BP は z 反転で閉じているので、先頭は面外の最大振れが法線側に来る向きへ、以降は
// 直前のメンバーに近い向きへ揃えて、族に沿って北側だけが並ぶようにする。
function haloMemberRecords(mu, params, members) {
  let previous = null;
  return members.map((raw, i) => {
    const member = refine(mu, raw);
    const sampled = cr3bp.sampleOrbitByArcLength(mu, member.state, member.period, POINTS_PER_ORBIT, REFINE_STEPS);
    const local = sampled.map((p) => halo.collinearBarycentricToLocal(params, p));
    const zs = local.map((p) => p[2]);
    const sign = previous === null
      ? (Math.max(...zs) >= -Math.min(...zs) ? 1 : -1)
      : (zs.reduce((sum, z, j) => sum + z * previous[j], 0) >= 0 ? 1 : -1);
    previous = zs.map((z) => sign * z);
    return {
      s: Number((i / (members.length - 1)).toFixed(4)),
      period: round(member.period),
      jacobi: round(member.jacobi),
      // xz 面を横切る瞬間の状態 [x, z, vy](y=vx=vz=0)。回転系・重心原点の無次元量。
      state: [member.state[0], sign * member.state[2], member.state[4]],
      points: local.map((p) => [round(p[0]), round(p[1]), round(sign * p[2])]),
    };
  });
}

// 副天体を回転系で逆行に周回する平面周期軌道を、指定半径で解く。副天体を回らない別解へ
// 落ちた場合は null。
function droMember(mu, radius) {
  const x0 = 1 - mu + radius;
  const meanMotion = Math.sqrt(mu / radius ** 3);
  // 副天体まわりの逆行円軌道を回転系へ移した速度(遠心分 radius を差し引く)。
  const vy0 = -Math.sqrt(mu / radius) - radius;
  const member = cr3bp.correctPlanarOrbit(mu, x0, vy0, Math.PI / (meanMotion + 1), REFINE_STEPS);
  if (member === null) return null;
  const points = cr3bp.sampleOrbitByArcLength(mu, member.state, member.period, POINTS_PER_ORBIT, REFINE_STEPS);
  if (orbitExtent(mu, points).closest < radius / 3) return null;
  return {
    radius: round(radius),
    period: round(member.period),
    jacobi: round(member.jacobi),
    // x 軸を横切る瞬間の状態 [x, vy](y=vx=0)。回転系・重心原点の無次元量。
    state: [member.state[0], member.state[4]],
    points: points.map((p) => [round(p[0] - 1 + mu), round(p[1])]),
  };
}

// 半径を対数等間隔に振って DRO 族を作る。上限はヒル半径(そこを超えると副天体を回る
// 閉軌道が無くなる)。収束しなかった半径は落とす。
function droFamily(mu, secondaryRadius) {
  const lo = Math.log(secondaryRadius * 1.5);
  const hi = Math.log(Math.cbrt(mu / 3) * 1.2);
  const members = [];
  for (let i = 0; i < DRO_MEMBERS; i++) {
    const radius = Math.exp(lo + ((hi - lo) * i) / (DRO_MEMBERS - 1));
    const member = droMember(mu, radius);
    if (member !== null) members.push(member);
  }
  return members;
}

const systems = {};
for (const system of systemsFromRegistry()) {
  const haloBySystem = {};
  for (const point of ['L1', 'L2', 'L3']) {
    const chain = trimToClosedMembers(system.mu, continueHaloFamily(system.mu, point, system.secondaryRadius));
    if (chain.length < HALO_MEMBERS) {
      process.stderr.write(`${system.key} ${point}: 族が短すぎるため出力しない(${chain.length} 件)\n`);
      continue;
    }
    const params = halo.collinearParams(point, system.mu);
    haloBySystem[point] = {
      gamma: round(params.gamma),
      members: haloMemberRecords(system.mu, params, pickAlongFamily(chain, HALO_MEMBERS)),
    };
    process.stderr.write(`${system.key} ${point}: 鎖 ${chain.length} 件から ${HALO_MEMBERS} 件を採用\n`);
  }
  systems[system.key] = {
    mu: system.mu,
    secondaryRadius: round(system.secondaryRadius),
    halo: haloBySystem,
    dro: { members: droFamily(system.mu, system.secondaryRadius) },
  };
}

physics.dispose();

mkdirSync(dirname(outPath), { recursive: true });
const document = {
  convention: [
    'CR3BP 回転系(主天体 (-mu,0,0)・副天体 (1-mu,0,0)、長さの単位=両天体間距離、平均運動 n=1)で解いた族。',
    'halo.members[].points は L点局所座標(原点=L点、長さの単位=gamma、x=主天体→副天体、z=公転面法線)の',
    '弧長等間隔な点列で、北側(z が法線側へ突出する側)だけを持つ。南側は z の符号を反転して得る。',
    'halo.members[].s は族に沿った正規化位置で、0=平面リヤプノフからの分岐直後、1=族末端。',
    'dro.members[].points は副天体を原点とする面内 (x,y) で、長さの単位は両天体間距離。radius も同じ単位。',
    'period はいずれも n=1 の無次元時間、jacobi はヤコビ定数 C=2*Omega-v^2。',
    'state は対称面を横切る瞬間の CR3BP 状態(halo は [x,z,vy]、dro は [x,vy]、いずれも重心原点)。',
  ].join('\n'),
  generator: 'tools/export-lagrange-orbits.mjs',
  systems,
};

// メンバー1件を1行に畳む。点列を行ごとに展開すると桁数の数倍の容量を区切り文字が占める。
const serialized = JSON.stringify(document)
  .replace(/,\{"s":/g, ',\n{"s":')
  .replace(/,\{"radius":/g, ',\n{"radius":')
  .replace(/"(systems|halo|dro|L1|L2|L3|sun-earth|earth-moon)":/g, '\n"$1":');
writeFileSync(outPath, `${serialized}\n`, 'utf8');

process.stderr.write(`${outPath} を書き出した\n`);
