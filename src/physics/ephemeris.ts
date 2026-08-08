// 天体暦: 恒星→惑星-衛星系重心→惑星/衛星の順に合成し(重心補正込み)、任意時刻の ECI
// 位置・速度・重力源配列・回転基準系・ラグランジュ点を返すサンプラ。分岐は SOLAR_SYSTEM の
// kind(恒星/惑星/衛星)だけで、固有名の分岐は持たない。ECI 化は「日心位置 − 地球の日心位置」
// の一箇所のみ(地球は自分自身を引くので厳密に 0 になる)。
// メモ化はしない — 呼び出し順に依存する隠れた制約を作らず、毎回すべてを素直に評価する。
// THREE/DOM 非依存の純関数群 + 状態(初期位相)を1つだけ持つサンプラクラス。
import { Quat, qRotate } from './attitude';
import { Attractor, AttractorId, Degree2Gravity, OrbitingId, PlanetId, SatelliteId } from './attractor';
import { cassiniSpinAxis, principalLongAxis } from './body-orientation';
import { ECL_POLE_ECI } from './ecliptic';
import { ReferenceFrame, FrameTransform } from './frame';
import { FrameRotation, KeplerOrbit, keplerOrbitMeanDirection, keplerOrbitNormal, keplerOrbitRotation, keplerOrbitState } from './kepler-orbit';
import { LagrangePoints, lagrangePoints } from './lagrange';
import { planetAngles } from './planet-orbit';
import { satelliteState } from './satellite-orbit';
import { bodyDef, CelestialBodyDef, SOLAR_SYSTEM } from './solar-system';
import { KinematicState, kinematicState } from './kinematic-state';
import { Vec3, add, addScaled, len, norm, sub, v3 } from './vec3';

// ECI の極軸(Y)。地球の自転軸はこの座標系の定義そのもの。
const ECI_POLE: Vec3 = v3(0, 1, 0);

// 回転しない座標系(ReferenceFrame.rotatingWith === null)の姿勢・角速度。
const IDENTITY_ROTATION: FrameRotation = { q: { x: 0, y: 0, z: 0, w: 1 } as Quat, omega: v3() };

type PlanetDef = Extract<CelestialBodyDef, { readonly kind: 'planet' }>;
type SatelliteDef = Extract<CelestialBodyDef, { readonly kind: 'satellite' }>;
type OrbitingDef = PlanetDef | SatelliteDef;

// 天体 id の一覧、および attractorsAt が返す重力源配列の順序。SOLAR_SYSTEM の宣言順が
// そのまま順序になるので、天体を増やしても足す場所はレジストリだけで済む。
// (Object.keys は string[] を返すため、キー型の復元にだけキャストを使う。)
const ATTRACTOR_IDS = Object.keys(SOLAR_SYSTEM) as AttractorId[];

// 惑星 planet を回る衛星の id 一覧。
function satellitesOf(planet: PlanetId): readonly SatelliteId[] {
  const ids: SatelliteId[] = [];
  for (const id of ATTRACTOR_IDS) {
    const def = bodyDef(id);
    if (def.kind === 'satellite' && def.planet === planet) ids.push(def.id);
  }
  return ids;
}

// 公転している天体の二体部分の軌道。衛星は周期摂動項を含まない平均要素(kepler)を持つ。
function keplerOrbitOf(def: OrbitingDef): KeplerOrbit {
  return def.kind === 'planet' ? def.orbit : def.orbit.kepler;
}

export class Ephemeris {
  // 天体ごとの平均黄経の初期オフセット。既定は月のみ乱数(現行の挙動)。テストは決定的な
  // 位相を渡すためコンストラクタで上書きする。セーブ/ロードは setPhaseOffsets で書き換える
  // (共有インスタンスを差し替えないため)。
  private phaseOffsets: Partial<Record<AttractorId, number>>;

  constructor(phaseOffsets: Partial<Record<AttractorId, number>> = { moon: Math.random() * 2 * Math.PI }) {
    this.phaseOffsets = phaseOffsets;
  }

  // 現在の位相オフセットのスナップショット(セーブ用)。
  getPhaseOffsets(): Partial<Record<AttractorId, number>> {
    return { ...this.phaseOffsets };
  }

  // 位相オフセットを丸ごと差し替える(ロード用)。メモ化を持たないため無効化は不要。
  setPhaseOffsets(phaseOffsets: Partial<Record<AttractorId, number>>): void {
    this.phaseOffsets = phaseOffsets;
  }

  // id の平均黄経の初期位相(未指定なら 0)。
  private phaseOf(id: AttractorId): number {
    return this.phaseOffsets[id] ?? 0;
  }

  // 惑星-衛星系重心の日心状態。
  private baryHelioState(def: PlanetDef, t: number): KinematicState {
    return keplerOrbitState(def.orbit, t, this.phaseOf(def.id));
  }

  // 衛星の惑星相対状態。太陽の方向は惑星-衛星系重心の軌道が持つ平均角度(planetAngles)
  // から取るので循環しない。
  private satelliteRelState(def: SatelliteDef, t: number): KinematicState {
    const planet = bodyDef(def.planet);
    const pAngles = planetAngles(planet.orbit, t, this.phaseOf(planet.id));
    return satelliteState(def.orbit, pAngles, t, this.phaseOf(def.id));
  }

  // 惑星本体の日心状態。重心の日心状態から、Σ(μ_衛星/(μ_惑星+Σμ_衛星))·r_衛星(惑星相対)
  // ぶんを引く(重心補正。位置・速度の両方に効く)。
  private planetHelioState(def: PlanetDef, t: number): KinematicState {
    const bary = this.baryHelioState(def, t);
    const satellites = satellitesOf(def.id);
    if (satellites.length === 0) return bary;

    // 重心を分け合う全質量(惑星本体 + 全衛星)に対する各衛星の比で、重心から差し引く量を決める。
    let muTotal = def.mu;
    for (const s of satellites) muTotal += bodyDef(s).mu;

    let r = bary.r;
    let v = bary.v;
    for (const s of satellites) {
      const satDef = bodyDef(s);
      const rel = this.satelliteRelState(satDef, t);
      const w = satDef.mu / muTotal;
      r = addScaled(r, rel.r, -w);
      v = addScaled(v, rel.v, -w);
    }
    return kinematicState(t, r, v);
  }

  // 天体の日心状態(恒星は原点に静止、惑星は重心補正込みの本体、衛星は惑星本体 + 惑星相対状態)。
  private helioStateOf(id: AttractorId, t: number): KinematicState {
    const def = bodyDef(id);
    switch (def.kind) {
      // 恒星は日心座標系の原点そのもの。
      case 'star':
        return kinematicState(t, v3(0, 0, 0), v3(0, 0, 0));
      case 'planet':
        return this.planetHelioState(def, t);
      // 衛星の日心状態は、惑星本体の日心状態に惑星相対状態を足すだけ。
      case 'satellite': {
        const planetHelio = this.planetHelioState(bodyDef(def.planet), t);
        const rel = this.satelliteRelState(def, t);
        return kinematicState(t, add(planetHelio.r, rel.r), add(planetHelio.v, rel.v));
      }
    }
  }

  // 指定時刻の ECI(地球中心)位置・速度。日心状態から地球の日心状態を引く一箇所だけで
  // ECI 化する。地球自身は同じ計算を2回引くので厳密に 0 になる。
  stateOf(id: AttractorId, t: number): KinematicState {
    const helio = this.helioStateOf(id, t);
    const earthHelio = this.helioStateOf('earth', t);
    return kinematicState(t, sub(helio.r, earthHelio.r), sub(helio.v, earthHelio.v));
  }

  // 指定時刻の ECI 位置。
  positionOf(id: AttractorId, t: number): Vec3 {
    return this.stateOf(id, t).r;
  }

  // 天体 id に固定した回転基準系(x̂ = 中心天体→id、ẑ = 軌道面法線)。中心は分類から決まる
  // (惑星なら恒星、衛星ならその惑星)。衛星の周期項は平均要素に含めないので、この基底は
  // 実位置の x̂ 軸から最大 1.4° ほどずれる(satellite-orbit.ts 参照)。
  orbitFrameRotationAt(id: OrbitingId, t: number): FrameRotation {
    return keplerOrbitRotation(keplerOrbitOf(bodyDef(id)), t, this.phaseOf(id));
  }

  // id の軌道面の法線(単位ベクトル、ECI)。
  orbitNormalAt(id: OrbitingId, t: number): Vec3 {
    return keplerOrbitNormal(keplerOrbitOf(bodyDef(id)), t, this.phaseOf(id));
  }

  // secondary(公転している天体)を副天体とする円制限三体問題のラグランジュ点。中心天体
  // (主天体)は分類から決まる(惑星なら恒星、衛星ならその惑星)。回転系は orbitFrameRotationAt(id)
  // の姿勢(x̂ = 主天体→副天体)そのものを使う。
  lagrangeAt(secondary: OrbitingId, t: number): LagrangePoints {
    const def = bodyDef(secondary);
    const primary: AttractorId = def.kind === 'planet' ? 'sun' : def.planet;
    const primaryPos = this.positionOf(primary, t);
    const secondaryPos = this.positionOf(secondary, t);
    const R = len(sub(secondaryPos, primaryPos));
    const { q } = this.orbitFrameRotationAt(secondary, t);
    const mu = def.mu / (bodyDef(primary).mu + def.mu);
    return lagrangePoints(mu, (x, y) => add(primaryPos, qRotate(q, v3(R * x, R * y, 0))));
  }

  // 太陽方向の単位ベクトル(ライティング・影判定用)。恒星が太陽1つであることは固有名でよい。
  sunDirAt(t: number): Vec3 {
    return norm(this.positionOf('sun', t));
  }

  // ReferenceFrame の時刻 t における剛体運動。原点は frame.center の状態、回転は frame.rotatingWith が
  // null なら恒等、そうでなければその天体自身の回転基準系。分岐は null 判定だけで、
  // 恒星/惑星/衛星の分類には関与しない。rotatingWith が非 null のとき常に公転している天体を
  // 指す(恒星は自身の公転を持たないので rotatingWith になり得ない)ことは ReferenceFrame の構築側
  // (frame.ts の FRAMES、または呼び出し側)が保証する。
  frameTransformAt(frame: ReferenceFrame, t: number): FrameTransform {
    const origin = this.stateOf(frame.center, t);
    const { q, omega } = frame.rotatingWith === null
      ? IDENTITY_ROTATION
      : this.orbitFrameRotationAt(frame.rotatingWith, t);
    return { origin: origin.r, originVel: origin.v, q, omega };
  }

  // 天体の2次重力場を時刻 t の姿勢込みで解決する。2次重力場を持たない天体は null。
  // 自転軸は PoleModel の分類で決まり、同期回転する天体の長軸は自身の平均黄経方向 —
  // 一様自転する本初子午線は真黄経ではなく平均黄経を追うため、真近点角ではこれを表せない。
  private degree2At(def: CelestialBodyDef, t: number): Degree2Gravity | null {
    if (def.kind === 'star' || def.degree2 === undefined) return null;
    const model = def.degree2;
    const orbit = keplerOrbitOf(def);
    const phase = this.phaseOf(def.id);
    // 軌道面法線は歳差するので、そこから組む自転軸も同じ周期で追従する。
    const pole = model.pole.kind === 'eciPole'
      ? ECI_POLE
      : cassiniSpinAxis(ECL_POLE_ECI, keplerOrbitNormal(orbit, t, phase), model.pole.obliquity);
    const tesseral = model.c22 === 0 ? null : {
      c22: model.c22,
      longAxis: principalLongAxis(pole, keplerOrbitMeanDirection(orbit, t, phase)),
    };
    return { j2: model.j2, refRadius: model.refRadius, pole, tesseral };
  }

  // 指定時刻の重力源一覧(SOLAR_SYSTEM の宣言順)。地球は原点に静止。
  attractorsAt(t: number): readonly Attractor[] {
    return ATTRACTOR_IDS.map((id) => {
      const def = bodyDef(id);
      return { id, mu: def.mu, radius: def.radius, state: this.stateOf(id, t), degree2: this.degree2At(def, t) };
    });
  }
}
