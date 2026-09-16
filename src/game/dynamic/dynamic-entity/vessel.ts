import type { Attitude } from '../../../physics/attitude';
import { DynamicEntity, type DynamicMotionFactory } from './dynamic-entity';
import type { DynamicView } from '../../../render/dynamic/dynamic-view';
import type { DynamicMotionProperties } from '../dynamic-motion';
import { DEFAULT_HISTORY_DURATION } from '../predicted-arc';
import { ShipMarkerRenderer } from '../../marker/ship-marker-renderer';

// 艦の材質・空力。大気抵抗は弾道係数の逆数 Cd·A/m [m^2/kg]、太陽輻射圧は輻射圧係数 ×
// 断面積質量比 C_R·A/m [m^2/kg] で表す。
export const SHIP_BCINV = 3.3e-3; // Cd≈2.2, A≈12m², m≈8t
export const SHIP_SRP_COEFF = 1.56e-2; // C_R≈1.3, A≈12m², m=PLAYER_MASS
const SHIP_BULK_DENSITY = 833; // [kg/m^3]
const SHIP_SPECIFIC_HEAT = 100; // [J/(kg·K)]
export const SHIP_RADIATING_AREA_PER_MASS = 0.07; // [m^2/kg]
export const MAX_HULL_TEMP = 1300; // 超過で熱防御飽和 → 機体喪失 [K]

// 宇宙機の物性を既定にした Motion の設定。overrides の項目で上書きする。
export function shipMotionOptions(
  attitude: Attitude, radius: number, overrides: DynamicMotionProperties = {},
): DynamicMotionProperties {
  return {
    attitude,
    radius,
    bcInv: SHIP_BCINV,
    srpCoeff: SHIP_SRP_COEFF,
    historyDuration: DEFAULT_HISTORY_DURATION,
    predictsFuture: true,
    specificHeat: SHIP_SPECIFIC_HEAT,
    bulkDensity: SHIP_BULK_DENSITY,
    radiatingAreaPerMass: SHIP_RADIATING_AREA_PER_MASS,
    ...overrides,
  };
}

export const MUZZLE_SPEED = 1000; // 機関砲初速 [m/s]

// 艦・敵・タンパク質が共有する、識別・寿命・一般HP・本体マーカーの基底。
// 部品一覧や部品由来の性能はここへ入れず、部品式の Ship 側へ残す。
export abstract class Vessel extends DynamicEntity {
  public override readonly combatTarget = true;
  private readonly markerRenderer = new ShipMarkerRenderer();
  private _hp: number;
  private _maxHp: number;

  public constructor(
    name: string,
    hp: number,
    motionFactory: DynamicMotionFactory,
    view: DynamicView,
    id: string,
  ) {
    super(motionFactory, view, id);
    this.setName(name);
    this._hp = hp;
    this._maxHp = hp;
  }

  public get hp(): number { return this._hp; }
  protected set hp(value: number) { this._hp = value; }
  public get maxHp(): number { return this._maxHp; }
  protected set maxHp(value: number) { this._maxHp = value; }

  // 残HP比を塗りで示す三角のHPマーカー。
  public hpMarkerSvg(): string { return this.markerRenderer.hpMarker(this.hp, this.maxHp); }

  // 進行方向へ回転させても崩れないHP表現。敵は中抜きスタイルを選べる。
  public headingHpMarkerSvg(isEnemy = false): string {
    return this.markerRenderer.headingHpMarker(this.hp, this.maxHp, isEnemy);
  }
}
