// 接続中ブースターへの操作と、分離時の実体生成・演出を管理する。
import type * as THREE from 'three/webgpu';
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { randSym } from '../../math/random';
import type { Attitude } from '../../physics/attitude';
import { DebrisPiece } from '../dynamic/dynamic-entity/debris-piece';
import { kinematicState } from '../../physics/kinematic-state';
import { add, addScaled, scale, v3, Vec3 } from '../../math/vec3';
import type { Notifier } from '../../hud/notifier';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { FlashEffects } from '../vfx/flash-effects';
import type { EntityRegistry } from '../dynamic/entity-registry';
import { DetachedBooster } from '../dynamic/dynamic-entity/detached-booster';
import type { BurnManagementViewModel } from '../hud/panels/burn-management-panel';
import {
  BOOSTER_INTERSTAGE_BOLT_Z,
  BOOSTER_INTERSTAGE_COVER_RADIUS,
  BOOSTER_INTERSTAGE_COVER_SEGMENTS,
  BOOSTER_INTERSTAGE_COVER_Z,
  BOOSTER_MOUNT_Z,
  BOOSTER_STAGE_DIMENSIONS,
} from '../../physics/booster-stage-shape';
import {
  boosterSeparationVelocities,
  nextBoosterId,
  type BoosterStage,
} from './booster-stack';
import type { DynamicMotion } from '../dynamic/dynamic-motion';
import type { AttachedBoosterMotion } from './attached-booster-motion';

// 分離式ブースターの標準段。自機 1,000 kg と並べたとき、1段あたりの乾燥+満載質量
// 1,000 kg、推力 0.6 MN で約 300 m/s² となるようにする。燃料 800 kg を 80 kg/s
// で燃やし切るので、通常のフレーム刻みでも十数秒の燃焼と最後の燃料切れを扱える。
const DEFAULT_DRY_MASS = 200; // [kg]
const DEFAULT_MAX_FUEL = 800; // [kg]
const DEFAULT_THRUST = 6e5; // [N]
const DEFAULT_FUEL_RATE = 80; // [kg/s]
const MAX_ATTACHED = 4;
const SEPARATION_SPEED = 8; // 爆砕ボルトによる相対分離速度 [m/s]
const COLLISION_GRACE = 0.5; // 分離直後に接続面同士が再衝突しない猶予 [s]

export class AttachedBoosters {
  public constructor(
    private readonly motion: DynamicMotion,
    private readonly boosterMotion: AttachedBoosterMotion,
    private readonly _notifier: Notifier,
    private readonly _worldSfx: WorldSfx,
    private readonly _scene: THREE.Scene,
    private readonly _fx: FlashEffects,
  ) {}

  // 燃焼管理パネルから標準ブースターを最後尾へ追加する。
  attach(): void {
    if (this.boosterMotion.stages.length >= MAX_ATTACHED) {
      this._notifier.hint(`ブースターは最大 ${MAX_ATTACHED} 段です`);
      return;
    }
    this.boosterMotion.attach({
      id: nextBoosterId(),
      dryMass: DEFAULT_DRY_MASS,
      fuel: DEFAULT_MAX_FUEL,
      maxFuel: DEFAULT_MAX_FUEL,
      thrust: DEFAULT_THRUST,
      fuelRate: DEFAULT_FUEL_RATE,
      ignited: false,
    });
    this._notifier.hint(`ブースターを追加: ${this.boosterMotion.stages.length} 段`);
  }

  // 最後尾段の点火を切り替える。点けられなかった理由は HUD のヒントで返す。
  toggleIgnition(): void {
    const active = this.activeStage();
    if (!active) {
      this._notifier.hint('点火できるブースターがありません');
      return;
    }
    const ignited = this.boosterMotion.toggleIgnition();
    this._notifier.hint(active.fuel <= 0
      ? '最後尾ブースターは燃料切れです'
      : `ブースター燃焼: ${ignited ? 'ON' : 'OFF'}`);
  }

  // 最後尾の段だけを独立エンティティへ移し、爆砕ボルトの相対速度を質量比で配る。
  decouple(registry: EntityRegistry): void {
    const stageIndex = this.boosterMotion.stages.length - 1;
    if (stageIndex < 0) {
      this._notifier.hint('分離できるブースターがありません');
      return;
    }
    const player = this.motion;
    const frontZ = BOOSTER_MOUNT_Z - stageIndex * BOOSTER_STAGE_DIMENSIONS.length;
    const centerZ = frontZ
      + (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    const jointR = add(player.state.r, qRotate(player.att.q, v3(0, 0, frontZ)));
    const boosterR = add(player.state.r, qRotate(player.att.q, v3(0, 0, centerZ)));
    const detachedStage = this.boosterMotion.detachOutermost()!;
    const boosterMass = detachedStage.dryMass + detachedStage.fuel;

    const forward = qRotate(player.att.q, LOCAL_FORWARD);
    const separated = boosterSeparationVelocities(
      player.state.v,
      forward,
      player.mass,
      boosterMass,
      SEPARATION_SPEED,
    );
    const t = player.state.t;
    player.state = kinematicState<'eci'>(t, player.state.r, separated.player);
    this.scatterInterstageHardware(t, jointR, separated.player, separated.booster, player.att, registry);
    registry.add(new DetachedBooster({
      stage: detachedStage,
      state: kinematicState<'eci'>(t, boosterR, separated.booster),
      att: {
        // 爆砕ボルトは中心軸上でトルクを与えない。姿勢モデルの inertia は操縦応答用の
        // 相対値で kg·m² ではないため、分離時は角速度をそのまま引き継ぐ。
        q: player.att.q,
        w: player.att.w,
        inertia: v3(1, 1, 0.4),
      },
      collisionEnableAt: t + COLLISION_GRACE,
    }, this._scene));

    this._fx.spawnGasPuff(kinematicState<'eci'>(t, jointR, player.state.v));
    this._worldSfx.decouple();
    player.invalidatePrediction();
    this._notifier.hint(`ブースター分離: 残り ${this.boosterMotion.stages.length} 段`);
  }

  // 段間カバーと爆砕ボルトを接続点から切り離し、径方向へ散らす。joint は接続面の中心(ECI)。
  private scatterInterstageHardware(
    t: number,
    joint: Vec3,
    playerVelocity: Vec3,
    boosterVelocity: Vec3,
    att: Attitude,
    registry: EntityRegistry,
  ): void {
    const coverBaseZ = BOOSTER_STAGE_DIMENSIONS.length + BOOSTER_INTERSTAGE_COVER_Z;
    const boltBaseZ = BOOSTER_STAGE_DIMENSIONS.length + BOOSTER_INTERSTAGE_BOLT_Z;
    const averageVelocity = scale(add(playerVelocity, boosterVelocity), 0.5);

    // カバー・ボルトとも周方向へ等分に並んでいるので、1周ぶんを角度で回しながら生む。
    for (let i = 0; i < BOOSTER_INTERSTAGE_COVER_SEGMENTS; i++) {
      const angle = (i * Math.PI * 2) / BOOSTER_INTERSTAGE_COVER_SEGMENTS;
      const radialLocal = v3(Math.cos(angle), Math.sin(angle), 0);
      const tangentLocal = v3(-Math.sin(angle), Math.cos(angle), 0);
      const radial = qRotate(att.q, radialLocal);
      const tangent = qRotate(att.q, tangentLocal);

      // 段間カバーは自機側の速度を基準に、径方向へ散らす。
      const coverPosition = add(joint, qRotate(att.q, v3(
        Math.cos(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        Math.sin(angle) * BOOSTER_INTERSTAGE_COVER_RADIUS,
        coverBaseZ,
      )));
      const coverVelocity = addScaled(
        addScaled(playerVelocity, radial, 4.5 + Math.random() * 2.5),
        tangent,
        randSym(1.5),
      );
      registry.add(new DebrisPiece(
        kinematicState<'eci'>(t, coverPosition, coverVelocity),
        { kind: 'boosterCover', segment: i, bornSim: t },
        { q: att.q, w: v3(randSym(0.8), randSym(1.8), randSym(0.8)), inertia: v3(1, 1.7, 2.4) },
        this._worldSfx, this._fx, undefined, this._scene,
      ));

      // 爆砕ボルトは両段の平均速度を基準に、カバーより速く径方向と機軸方向へ。
      const boltPosition = add(joint, qRotate(att.q, v3(
        Math.cos(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        Math.sin(angle) * (BOOSTER_INTERSTAGE_COVER_RADIUS + 0.08),
        boltBaseZ,
      )));
      const boltVelocity = addScaled(
        addScaled(
          addScaled(averageVelocity, radial, 6.0 + Math.random() * 3.5),
          tangent,
          randSym(2.0),
        ),
        qRotate(att.q, LOCAL_FORWARD),
        randSym(2.5),
      );
      registry.add(new DebrisPiece(
        kinematicState<'eci'>(t, boltPosition, boltVelocity),
        { kind: 'boosterBolt', segment: i, bornSim: t },
        { q: att.q, w: v3(randSym(2.5), randSym(2.5), randSym(2.5)), inertia: v3(0.4, 0.5, 0.7) },
        this._worldSfx, this._fx, undefined, this._scene,
      ));
    }
  }

  // 燃焼管理パネルへ渡す表示状態。操作の可否もここで決めてパネルへ伝える。
  managementViewModel(): BurnManagementViewModel {
    const active = this.activeStage();
    return {
      stageCount: this.boosterMotion.stages.length,
      maxStages: MAX_ATTACHED,
      totalMass: this.motion.mass,
      activeFuel: active?.fuel ?? 0,
      activeFuelMax: active?.maxFuel ?? 0,
      burnState: !active ? 'idle' : active.fuel <= 0 ? 'empty' : active.ignited ? 'burning' : 'ready',
      ignitionOn: active?.ignited ?? false,
      canAttach: this.boosterMotion.stages.length < MAX_ATTACHED,
      canToggleIgnition: active !== undefined && active.fuel > 0,
      canDecouple: active !== undefined,
    };
  }

  private activeStage(): BoosterStage | undefined {
    const stages = this.boosterMotion.stages;
    return stages[stages.length - 1];
  }
}
