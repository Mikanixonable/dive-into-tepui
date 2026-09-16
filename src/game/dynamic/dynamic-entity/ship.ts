import { Attitude } from '../../../physics/attitude';
import { DynamicEntity, type DynamicMotionFactory } from './dynamic-entity';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotionProperties } from '../dynamic-motion';
import { SHIP_ARROWHEAD_POINTS, triangleHpMarkerSvg } from '../../marker/marker-shapes';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';

// 艦の材質・空力。大気抵抗は弾道係数の逆数 Cd·A/m [m^2/kg]、太陽輻射圧は輻射圧係数 ×
// 断面積質量比 C_R·A/m [m^2/kg] で表す。
export const SHIP_BCINV = 3.3e-3; // Cd≈2.2, A≈12m², m≈8t
export const SHIP_SRP_COEFF = 1.56e-2; // C_R≈1.3, A≈12m², m=PLAYER_MASS
// 宇宙機の実効密度で、曲率半径 0.6 m を与える値。
const SHIP_BULK_DENSITY = 833; // [kg/m^3]
// PLAYER_MASS と掛けて外殻の熱容量 0.1 MJ/K。射撃・被弾の発熱量はこれを基準に決めてある。
const SHIP_SPECIFIC_HEAT = 100; // [J/(kg·K)]
// 艦体自体の放熱面積 70 m² を PLAYER_MASS で割った値。放熱板の展開ぶんはこれに上乗せする。
export const SHIP_RADIATING_AREA_PER_MASS = 0.07; // [m^2/kg]
export const MAX_HULL_TEMP = 1300; // 超過で熱防御飽和 → 機体喪失 [K]

// 自機の質量 [kg]。既定パーツのスラスター推力はこの質量で THROTTLE_LEVELS の最大値の
// 加速度になるよう決めてあるので、両者を別々に動かすと表示と実挙動がずれる。
export const PLAYER_MASS = 1000;

// 自機の主慣性モーメント(相対値、3軸とも異なる非対称形にしてジャニベコフ効果を起こす)
export const PLAYER_INERTIA_PITCH = 1.0; // ピッチ軸(X)。3軸中の中間値 = 不安定軸
export const PLAYER_INERTIA_YAW = 1.6; // ヨー軸(Y)
export const PLAYER_INERTIA_ROLL = 0.5; // ロール軸(Z、機体前後)。細長い形状に見合って最小

// 艦の物性を既定にした Motion の設定。overrides の項目で上書きする。
export function shipMotionOptions(
  attitude: Attitude, radius: number, overrides: DynamicMotionProperties = {},
): DynamicMotionProperties {
  return {
    attitude,
    radius,
    bcInv: SHIP_BCINV,
    srpCoeff: SHIP_SRP_COEFF,
    // 過去線を保持し、予測も引く
    historyDuration: DEFAULT_HISTORY_DURATION,
    predictsFuture: true,
    // 熱の物性
    specificHeat: SHIP_SPECIFIC_HEAT,
    bulkDensity: SHIP_BULK_DENSITY,
    radiatingAreaPerMass: SHIP_RADIATING_AREA_PER_MASS,
    ...overrides,
  };
}

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]

// 艦(自機・敵機)に共通するもの — 名前、装甲値、残量を示す HP マーカー。
export abstract class Ship extends DynamicEntity {
  public override readonly combatTarget = true;

  // 残りの装甲値と満タンの装甲値 [HP]。正本は具象が持つ。
  public abstract readonly hp: number;
  public abstract readonly maxHp: number;

  // 基底の識別・Motion・View を組み、名前で初期化する。
  public constructor(
    name: string,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id: string,
  ) {
    super(motionFactory, view, id);
    this.setName(name);
  }

  // 残 HP 比を塗りで示す三角の HP マーカーの SVG。
  public hpMarkerSvg(): string {
    return triangleHpMarkerSvg(this.hp, this.maxHp);
  }

  // 進行方向へ回転させても崩れない HP 表現。後部が凹んだ鋭角矢尻の外形と、底辺からの塗り高さで
  // 残HP比を示す。味方・自機は単色塗りつぶし(fill-opacity: 1)、敵機は中抜きスタイル。
  public headingHpMarkerSvg(isEnemy = false): string {
    // 塗りの上端は、底辺から矢尻の頂点までを残 HP 比で内分した高さ。
    const ratio = this.maxHp > 0 ? Math.max(0, Math.min(1, this.hp / this.maxHp)) : 0;
    const apexY = 1.5;
    const baseY = 21;
    const fillTopY = (baseY - ratio * (baseY - apexY)).toFixed(2);
    const clipId = `hpfill-${this.name}`;
    const pts = SHIP_ARROWHEAD_POINTS;
    if (isEnemy) {
      return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">` +
        `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
        `</svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="24" height="24" aria-label="HP ${Math.max(0, this.hp)} / ${this.maxHp}">` +
      `<clipPath id="${clipId}"><rect x="0" y="${fillTopY}" width="24" height="24"/></clipPath>` +
      `<polygon points="${pts}" fill="currentColor" fill-opacity="1" clip-path="url(#${clipId})"/>` +
      `<polygon points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
      `</svg>`;
  }
}
