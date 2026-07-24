// 天体暦の状態: 太陽・月の ECI 位置(初期位相はゲームごとに決定)と、
// それに由来する太陽方向・地球影の日照率。位置の計算式そのものは
// physics/ephemeris.ts の純関数に任せ、ここでは simTime でサンプルした状態を保持する。
// マップモードだけで見せる参照軌道線(静止軌道高度の目盛り・月軌道)もここが持つ —
// どちらも天体暦の状態(月の位置・月自身)そのものから作られる表示なので、
// 軌道線の Elements 算出元と描画オブジェクトの所有を分けない。
import * as THREE from 'three/webgpu';
import { moonPosition, sunPosition } from '../physics/ephemeris';
import { Elements, elementsFromState, R_EARTH } from '../physics/orbital';
import { Vec3, addScaled, dot, len, norm, scale, sub, v3 } from '../physics/vec3';
import { OrbitLine } from '../render/orbitline';
import { FloatingOrigin } from './floating-origin';
import * as C from './const';

// 静止軌道高度の参照リング。実在の衛星や特定経度を表すものではない定数。
const GEO_ELEMENTS: Elements = {
  a: R_EARTH + 35786e3,
  e: 1e-6,
  p: R_EARTH + 35786e3,
  incDeg: 0,
  apAlt: 35786e3,
  peAlt: 35786e3,
  period: 86164,
  hHat: v3(0, 1, 0),
  pHat: v3(1, 0, 0),
  qHat: v3(0, 0, -1),
};

export class EphemerisSystem {
  readonly sunPhase0 = 0; // 昼(太陽が+X側)から開始するように固定
  readonly moonPhase0 = Math.random() * Math.PI * 2;
  private sunPosV: Vec3 = v3(1.496e11, 0, 0);
  private moonPosV: Vec3 = v3(3.844e8, 0, 0);
  private sunDirV: Vec3 = v3(1, 0, 0);

  readonly geoLine = new OrbitLine(0x8b93a0, 0.2);
  readonly moonLine = new OrbitLine(0xaab3c0, 0.2);

  constructor(scene: THREE.Scene) {
    this.geoLine.line.renderOrder = 0;
    this.moonLine.line.renderOrder = 0;
    scene.add(this.geoLine.line);
    scene.add(this.moonLine.line);
  }

  get sunPos(): Vec3 {
    return this.sunPosV;
  }

  get moonPos(): Vec3 {
    return this.moonPosV;
  }

  // 太陽方向の単位ベクトル(ライティング・影判定用)
  get sunDir(): Vec3 {
    return this.sunDirV;
  }

  // 太陽・月の ECI 位置を simTime から更新する
  update(simTime: number): void {
    this.sunPosV = sunPosition(simTime, this.sunPhase0);
    this.moonPosV = moonPosition(simTime, this.moonPhase0);
    this.sunDirV = norm(this.sunPosV);
  }

  // 自機位置の地表影(円柱近似 + 縁のぼかし)による日照率 0..1
  shadowLitFactor(r: Vec3): number {
    const along = dot(r, this.sunDirV);
    if (along >= 0) return 1; // 太陽側
    const perp = len(addScaled(r, this.sunDirV, -along));
    return Math.min(1, Math.max(0, (perp - R_EARTH) / C.SHADOW_PENUMBRA));
  }

  // マップモード中だけ geo/moon の参照線を表示する(戦闘ビューでは非表示)。
  syncReferenceLines(simTime: number, fo: FloatingOrigin, mapMode: boolean): void {
    if (!mapMode) {
      this.geoLine.sync(null, fo);
      this.moonLine.sync(null, fo);
      return;
    }
    this.geoLine.sync(GEO_ELEMENTS, fo, false);
    this.moonLine.sync(this.moonOrbitElements(simTime), fo, false);
  }

  // 月の接触軌道要素(表示専用)。月自身は entity ではなく解析式のみを持つため、
  // 近接2点の位置を数値微分して疑似的な r, v を作り、他の軌道線と同じ経路に載せる。
  private moonOrbitElements(simTime: number): Elements | null {
    const dt = 10;
    const r1 = moonPosition(simTime, this.moonPhase0);
    const r2 = moonPosition(simTime + dt, this.moonPhase0);
    return elementsFromState(r1, scale(sub(r2, r1), 1 / dt));
  }
}
