import * as THREE from 'three/webgpu';
import { Attitude } from '../../../physics/attitude';
import { KinematicState, kinematicState } from '../../../physics/kinematic-state';
import { CelestialMotion } from '../../../physics/celestial-motion';
import { Vec3 } from '../../../math/vec3';
import type { Stage } from '../../stages/stage';
import type { Contact } from './contact';
import type { WorldSfx } from '../../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../../vfx/effects-system';
import type { CapKind } from './entity-kind';
import {
  buildBarrelMesh,
  buildCasingMesh,
  buildMagazineFrame,
  DEBRIS_FRAGMENT_VARIANT_COUNT,
} from '../../../render/ships';
import {
  buildBoosterExplosiveBoltMesh,
  buildBoosterInterstageCoverPanelMesh,
} from '../../../render/booster';
import { DynamicEntity, SMALL_DEBRIS_BCINV, SMALL_DEBRIS_SRP_COEFF, SMALL_DEBRIS_BULK_DENSITY, SMALL_DEBRIS_SPECIFIC_HEAT, SMALL_DEBRIS_RADIATING_AREA_PER_MASS, SMALL_DEBRIS_MAX_TEMP } from './dynamic-entity';
import { Player } from '../../player/player';
import { Bullet } from './bullet';

const BARREL_BULK_DENSITY = 7850; // [kg/m^3]

const BARREL_MAX_TEMP = 1700; // 鋼の融点 [K]
// BARREL_MASS と掛けて砲身の熱容量 0.15 MJ/K。射撃発熱はこれを基準に決めてある。
export const BARREL_SPECIFIC_HEAT = 500; // [J/(kg·K)]
// 砲身の表面積 14 m² を BARREL_MASS で割った値。
export const BARREL_RADIATING_AREA_PER_MASS = 0.047; // [m^2/kg]

const BOOSTER_HARDWARE_LIFETIME = 2.4; // 段間カバー/爆砕ボルトの飛散表示時間 [s]

const CASING_LIFETIME = 1800; // 薬莢寿命 [sim s]
import {
  SHIP_DARK_HULL_COLOR,
} from '../../../render/vfx-style';

// DebrisPiece の見た目・振る舞いの種別。
export type DebrisKind =
  | { kind: 'fragment'; accent: string | number; size: number; }
  | { kind: 'barrel'; bornTemperature: number; bornThermalDeviation: number; }
  | { kind: 'magazineFrame'; }
  | { kind: 'casing'; bornSim: number; }
  | { kind: 'boosterCover'; segment: number; bornSim: number; }
  | { kind: 'boosterBolt'; segment: number; bornSim: number; };

// DebrisKind の種別に応じたメッシュを構築する。fragment は InstancedPool 経由で描くため
// ジオメトリを持たない — size だけを renderObject.scale へ焼き、どのバリアント/色を使うかは
// DebrisPiece 自身が持つ(DynamicSystem.sync が variant ごとのプールへ push する)。
function buildDebrisRenderObject(debrisKind: DebrisKind): THREE.Object3D {
  switch (debrisKind.kind) {
    case 'fragment': {
      const renderObject = new THREE.Object3D();
      renderObject.scale.setScalar(debrisKind.size);
      return renderObject;
    }
    case 'barrel': return buildBarrelMesh();
    case 'magazineFrame': return buildMagazineFrame();
    case 'casing': return buildCasingMesh();
    case 'boosterCover': return buildBoosterInterstageCoverPanelMesh(debrisKind.segment);
    case 'boosterBolt': return buildBoosterExplosiveBoltMesh(debrisKind.segment);
  }
}

// 材質ごとの熱的な性質。
interface DebrisThermal {
  readonly specificHeat: number; // [J/(kg·K)]
  readonly bulkDensity: number; // [kg/m^3]
  readonly radiatingAreaPerMass: number; // [m^2/kg]
  readonly maxTemperature: number; // これを超えると焼失する温度 [K]
}

const ALUMINIUM_DEBRIS: DebrisThermal = {
  specificHeat: SMALL_DEBRIS_SPECIFIC_HEAT,
  bulkDensity: SMALL_DEBRIS_BULK_DENSITY,
  radiatingAreaPerMass: SMALL_DEBRIS_RADIATING_AREA_PER_MASS,
  maxTemperature: SMALL_DEBRIS_MAX_TEMP,
};

const STEEL_BARREL: DebrisThermal = {
  specificHeat: BARREL_SPECIFIC_HEAT,
  bulkDensity: BARREL_BULK_DENSITY,
  radiatingAreaPerMass: BARREL_RADIATING_AREA_PER_MASS,
  maxTemperature: BARREL_MAX_TEMP,
};

// 種別ごとの材質。砲身だけが鋼で、赤熱する温度でも構造を保つ。
function debrisThermal(kind: DebrisKind['kind']): DebrisThermal {
  return kind === 'barrel' ? STEEL_BARREL : ALUMINIUM_DEBRIS;
}

export class DebrisPiece extends DynamicEntity {
  override readonly bcInv = SMALL_DEBRIS_BCINV;
  protected readonly srpCoeff = SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat: number;
  protected readonly bulkDensity: number;
  protected readonly maxTemperature: number;
  // 輻射面積の比 [m^2/kg]。
  private readonly materialRadiatingAreaPerMass: number;
  protected override get radiatingAreaPerMass(): number {
    return this.materialRadiatingAreaPerMass;
  }

  // fragment のみ意味を持つ: どのバリアントジオメトリを使うか、InstancedPool の
  // per-instance color へ渡す色。DynamicSystem.sync が variant ごとのプールへ push する。
  readonly fragmentVariant: number;
  readonly fragmentColor: THREE.Color | null;
  override readonly capKind: CapKind;

  // DebrisKind に応じたメッシュ・質量で初期化する。radius は剛体接触半径。fragment は
  // 剛体接触に参加しない(排莢直後の薬莢を弾いてしまう/破片が跳ね回るのを避ける)。
  constructor(
    state: KinematicState,
    readonly debrisKind: DebrisKind,
    att: Attitude,
    private readonly _worldSfx: WorldSfx,
    private readonly _fx: EffectsSystem,
    radius?: number,
    scene?: THREE.Scene,
  ) {
    // 薬莢・破片の renderObject は InstancedPool へ渡す変換を保持する。
    super(
      state,
      buildDebrisRenderObject(debrisKind),
      scene,
      att,
      undefined,
      debrisKind.kind !== 'casing' && debrisKind.kind !== 'fragment',
    );
    const thermal = debrisThermal(debrisKind.kind);
    this.specificHeat = thermal.specificHeat;
    this.bulkDensity = thermal.bulkDensity;
    this.maxTemperature = thermal.maxTemperature;
    this.materialRadiatingAreaPerMass = thermal.radiatingAreaPerMass;
    this.radius = radius ?? 0;
    this.collides = debrisKind.kind !== 'fragment'
      && debrisKind.kind !== 'boosterCover'
      && debrisKind.kind !== 'boosterBolt';
    this.contactDamageWeight = 0;
    this.capKind = debrisKind.kind === 'casing' ? 'casing' : 'debris';
    if (debrisKind.kind === 'barrel') {
      this.temperature = debrisKind.bornTemperature;
      this.thermalDeviation = debrisKind.bornThermalDeviation;
    }
    if (debrisKind.kind === 'fragment') {
      this.fragmentVariant = Math.floor(Math.random() * DEBRIS_FRAGMENT_VARIANT_COUNT);
      const dark = Math.random() < 0.30;
      this.fragmentColor = new THREE.Color(dark ? SHIP_DARK_HULL_COLOR : debrisKind.accent);
    } else {
      this.fragmentVariant = -1;
      this.fragmentColor = null;
    }
    // 全種別が試験粒子。触れた相手の速度を変えないので、相手の予測弧も捨てられない。
    this.mass = 0;
  }

  get kind(): DebrisKind['kind'] { return this.debrisKind.kind; }

  // 弾が当たったらガスパフを噴いて消える(弾自身の消滅は Bullet.collideWithEntity が書く)。
  // 薬莢が艦(操作対象に限らず Player 全般)に触れたときは、からんと音を鳴らす。
  collideWithEntity(other: DynamicEntity, contact: Contact): void {
    if (other instanceof Bullet) {
      this._fx.spawnGasPuff(kinematicState<'eci'>(contact.selfState.t, contact.point, contact.selfState.v));
      return;
    }
    if (this.debrisKind.kind === 'casing' && other instanceof Player) this._worldSfx.clank();
  }

  // 寿命を持つ薬莢・段間ハードウェアの期限切れ絶対時刻。無ければ null。
  // nextSimulationEventTime と checkLoss の両方がこの1箇所だけを参照する — 別々に
  // bornSim+寿命を計算すると丸め誤差でイベント予告と実際の消滅判定がずれかねない。
  private get expiresAt(): number | null {
    switch (this.debrisKind.kind) {
      case 'casing': return this.debrisKind.bornSim + CASING_LIFETIME;
      case 'boosterCover':
      case 'boosterBolt': return this.debrisKind.bornSim + BOOSTER_HARDWARE_LIFETIME;
      default: return null;
    }
  }

  nextSimulationEventTime(simTime: number): number | null {
    const expiresAt = this.expiresAt;
    return expiresAt !== null && expiresAt >= simTime ? expiresAt : null;
  }

  // 再突入判定に加え、寿命を持つデブリは表示時間の超過でも消す。
  checkLoss(
    dt: number, simTime: number, activeStage: Stage, playerPos: Vec3,
    atmosphereBodies: readonly CelestialMotion[],
  ): void {
    super.checkLoss(dt, simTime, activeStage, playerPos, atmosphereBodies);
    if (!this.alive) return;
    const expiresAt = this.expiresAt;
    if (expiresAt !== null && simTime >= expiresAt) this.alive = false;
  }
}
