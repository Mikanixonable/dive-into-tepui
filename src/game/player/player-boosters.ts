// 自機に接続された分離式ブースターの運用。段スタック(BoosterStack)の上に、既定段の諸元・
// 船体への模型の取り付け・質量と慣性への反映・分離・プルーム・燃焼管理パネルの文言を載せる。
//
// 質量と慣性は自機のものを直接書き換える。段の増減と燃焼のたびに追随させる必要があり、
// 自機側から呼び直させると正本が二重になるため。
import * as THREE from 'three/webgpu';
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { kinematicState } from '../../physics/kinematic-state';
import { add, scale, v3, Vec3 } from '../../math/vec3';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import { Hud } from '../hud/hud';
import { WorldSfx } from '../../audio/sfx/world-sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { DynamicSystem } from '../dynamic/dynamic-system';
import { DetachedBooster } from '../dynamic/dynamic-entity/detached-booster';
import { PLAYER_MASS, PLAYER_INERTIA_PITCH, PLAYER_INERTIA_YAW, PLAYER_INERTIA_ROLL } from '../dynamic/dynamic-entity/ship';
import type { BurnManagementViewModel } from '../hud/panels/burn-management-panel';
import {
  BOOSTER_STAGE_DIMENSIONS,
  BoosterPlumeSet,
  buildBoosterStage,
  type BoosterStage as BoosterStageModel,
} from '../../render/booster';
import {
  BoosterStack,
  boosterAverageAcceleration,
  boosterSeparationVelocities,
  nextBoosterId,
  type BoosterStackData,
  type BoosterStage,
} from './booster-stack';
import { Player } from './player';

// 分離式ブースターの標準段。自機 1,000 kg と並べたとき、1段あたりの乾燥+満載質量
// 1,000 kg、推力 0.6 MN で約 300 m/s² となるようにする。燃料 800 kg を 80 kg/s
// で燃やし切るので、通常のフレーム刻みでも十数秒の燃焼と最後の燃料切れを扱える。
const DEFAULT_DRY_MASS = 200; // [kg]
const DEFAULT_MAX_FUEL = 800; // [kg]
const DEFAULT_THRUST = 6e5; // [N]
const DEFAULT_FUEL_RATE = 80; // [kg/s]
const MAX_ATTACHED = 4;
const MOUNT_Z = -4.0; // 船体中心から最初の段の前端まで [m]
const SEPARATION_SPEED = 8; // 爆砕ボルトによる相対分離速度 [m/s]
const COLLISION_GRACE = 0.5; // 分離直後に接続面同士が再衝突しない猶予 [s]

export class PlayerBoosters {
  private readonly stack: BoosterStack;
  private readonly plumes: BoosterPlumeSet;
  private readonly models: BoosterStageModel[] = [];
  private _thrust: Vec3 | null = null;
  private lastBurnRatio = 0;

  // saved を渡せば段の構成と燃料・点火状態を復元する。省略時は段なしで始まる。
  constructor(
    private readonly player: Player,
    private readonly _hud: Hud,
    private readonly _worldSfx: WorldSfx,
    private readonly _scene: THREE.Scene,
    private readonly _fx: EffectsSystem,
    saved?: BoosterStackData,
  ) {
    this.stack = saved ? BoosterStack.importData(saved) : new BoosterStack();
    for (const stage of this.stack.stages) nextBoosterId(stage.id);
    this.plumes = new BoosterPlumeSet(_scene);
    this.rebuildModels();
    this.refreshMassAndInertia();
  }

  // 最後尾段がこのフレームに発生させている推力加速度。燃焼していなければ null。
  get thrust(): Vec3 | null { return this._thrust; }

  // 燃焼管理パネルから標準ブースターを最後尾へ追加する。
  attach(): void {
    if (this.stack.stages.length >= MAX_ATTACHED) {
      this._hud.hint(`ブースターは最大 ${MAX_ATTACHED} 段です`);
      return;
    }
    this.stack.attach({
      id: nextBoosterId(),
      dryMass: DEFAULT_DRY_MASS,
      fuel: DEFAULT_MAX_FUEL,
      maxFuel: DEFAULT_MAX_FUEL,
      thrust: DEFAULT_THRUST,
      fuelRate: DEFAULT_FUEL_RATE,
      ignited: false,
    });
    this.rebuildModels();
    this.refreshMassAndInertia();
    this.player.invalidatePrediction();
    this._hud.hint(`ブースターを追加: ${this.stack.stages.length} 段`);
  }

  // 最後尾段の点火を切り替える。点けられなかった理由は HUD のヒントで返す。
  toggleIgnition(): void {
    const active = this.activeStage();
    if (!active) {
      this._hud.hint('点火できるブースターがありません');
      return;
    }
    const ignited = this.stack.toggleIgnition();
    this.player.invalidatePrediction();
    this._hud.hint(active.fuel <= 0
      ? '最後尾ブースターは燃料切れです'
      : `ブースター燃焼: ${ignited ? 'ON' : 'OFF'}`);
  }

  // 最後尾の段だけを独立エンティティへ移し、爆砕ボルトの相対速度を質量比で配る。
  decouple(entities: DynamicSystem): void {
    const stageIndex = this.stack.stages.length - 1;
    if (stageIndex < 0) {
      this._hud.hint('分離できるブースターがありません');
      return;
    }
    const player = this.player;
    const frontZ = MOUNT_Z - stageIndex * BOOSTER_STAGE_DIMENSIONS.length;
    const centerZ = frontZ
      + (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    const jointR = add(player.state.r, qRotate(player.att.q, v3(0, 0, frontZ)));
    const boosterR = add(player.state.r, qRotate(player.att.q, v3(0, 0, centerZ)));
    const detachedStage = this.stack.detachOutermost()!;
    const boosterMass = detachedStage.dryMass + detachedStage.fuel;
    this.refreshMassAndInertia();

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
    this._fx.spawnBoosterSeparation(t, jointR, separated.player, separated.booster, player.att);
    entities.add(new DetachedBooster({
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

    this.clearThrust();
    this.rebuildModels();
    this._fx.spawnGasPuff(kinematicState<'eci'>(t, jointR, player.state.v));
    this._worldSfx.decouple();
    player.invalidatePrediction();
    this._hud.hint(`ブースター分離: 残り ${this.stack.stages.length} 段`);
  }

  // 燃焼管理パネルへ渡す表示状態。操作の可否もここで決めてパネルへ伝える。
  managementViewModel(): BurnManagementViewModel {
    const active = this.activeStage();
    return {
      stageCount: this.stack.stages.length,
      maxStages: MAX_ATTACHED,
      totalMass: this.player.mass,
      activeFuel: active?.fuel ?? 0,
      activeFuelMax: active?.maxFuel ?? 0,
      burnState: !active ? 'idle' : active.fuel <= 0 ? 'empty' : active.ignited ? 'burning' : 'ready',
      ignitionOn: active?.ignited ?? false,
      canAttach: this.stack.stages.length < MAX_ATTACHED,
      canToggleIgnition: active !== undefined && active.fuel > 0,
      canDecouple: active !== undefined,
    };
  }

  // simDt 秒ぶん最後尾段を燃焼させ、減った燃料を自機の質量と慣性へ反映する。
  step(simDt: number): void {
    const massBefore = PLAYER_MASS + this.stack.totalMass;
    const burn = this.stack.step(simDt);
    this.refreshMassAndInertia();
    this.lastBurnRatio = burn.burnRatio;
    const averageAcceleration = boosterAverageAcceleration(burn, massBefore, this.player.mass);
    this._thrust = averageAcceleration > 0
      ? scale(qRotate(this.player.att.q, LOCAL_FORWARD), averageAcceleration)
      : null;
  }

  clearThrust(): void {
    this._thrust = null;
    this.lastBurnRatio = 0;
  }

  // effectPos は機体メッシュを載せている表示状態の位置。揃えないと「機体は未来位置、
  // プルームは現在位置」に割れる。
  sync(
    fo: FloatingOrigin, effectPos: Vec3, displayTime: number,
    visible: boolean, camera: CameraSystem, style: RenderStyle,
  ): void {
    const player = this.player;
    const activeIndex = this.stack.stages.length - 1;
    const atCurrentTime = Math.abs(displayTime - player.state.t) <= 1e-6;
    if (activeIndex < 0 || this._thrust === null || !visible || !atCurrentTime || camera.zoomActive) {
      this.plumes.sync([], camera.activeCamera.quaternion, style);
      return;
    }
    const nozzleZ = MOUNT_Z
      - activeIndex * BOOSTER_STAGE_DIMENSIONS.length
      + BOOSTER_STAGE_DIMENSIONS.nozzleExitZ;
    const nozzleWorld = add(effectPos, qRotate(player.att.q, v3(0, 0, nozzleZ)));
    const tail = qRotate(player.att.q, v3(0, 0, -1));
    this.plumes.sync([{
      position: fo.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tail.x, tail.y, tail.z),
      intensity: Math.max(0.25, this.lastBurnRatio),
      visible: true,
    }], camera.activeCamera.quaternion, style);
  }

  serialize(): BoosterStackData {
    return this.stack.exportData();
  }

  dispose(): void {
    this.plumes.dispose();
    for (const model of this.models) model.dispose();
    this.models.length = 0;
  }

  private activeStage(): BoosterStage | undefined {
    const stages = this.stack.stages;
    return stages[stages.length - 1];
  }

  private rebuildModels(): void {
    for (const model of this.models) model.dispose();
    this.models.length = 0;
    for (let i = 0; i < this.stack.stages.length; i++) {
      // 段間カバーは内側段の後端にだけ残す。最後尾段にはカバーが無く、
      // 分離時はこの接続部を爆砕ボルトと一緒にデブリへ移す。
      const model = buildBoosterStage({ interstageCover: i < this.stack.stages.length - 1 });
      model.position.z = MOUNT_Z - i * BOOSTER_STAGE_DIMENSIONS.length;
      this.player.renderObject.add(model);
      this.models.push(model);
    }
  }

  // 段を長く連ねるほど、慣性は質量比よりも速く増える(長い棒ほど回しにくい)。
  private refreshMassAndInertia(): void {
    const player = this.player;
    player.mass = PLAYER_MASS + this.stack.totalMass;
    const massRatio = player.mass / PLAYER_MASS;
    const lengthFactor = 1 + 0.35 * this.stack.stages.length ** 2;
    player.att = {
      ...player.att,
      inertia: v3(
        PLAYER_INERTIA_PITCH * massRatio * lengthFactor,
        PLAYER_INERTIA_YAW * massRatio * lengthFactor,
        PLAYER_INERTIA_ROLL * massRatio,
      ),
    };
  }
}
