import * as THREE from 'three/webgpu';
import { qRotate, type Attitude } from '../../physics/attitude';
import { kinematicState, type KinematicState } from '../../physics/kinematic-state';
import { add, scale, v3 } from '../../physics/vec3';
import type { FloatingOrigin } from '../floating-origin';
import type { CameraSystem } from '../camera/camera-system';
import type { DetachedBoosterSaveData } from '../save-data';
import * as C from '../const';
import {
  BoosterStack,
  boosterAverageAcceleration,
  type BoosterStage as BoosterStageState,
} from '../player/booster-stack';
import { nextBoosterId } from '../player/booster-id';
import {
  BOOSTER_STAGE_DIMENSIONS,
  BoosterPlume,
  buildBoosterStage,
  type BoosterStage as BoosterStageModel,
} from '../../render/booster';
import { GameEntity } from './game-entity';
import type { RenderStyle } from '../../render/render-style';

export type DetachedBoosterInit =
  | {
    readonly stage: BoosterStageState;
    readonly state: KinematicState;
    readonly att: Attitude;
    readonly collisionEnableAt: number;
  }
  | { readonly saved: DetachedBoosterSaveData; readonly simTime: number };

// 分離後の一段。接続時の燃料・点火状態を引き継ぎ、燃料切れまで自律的に燃焼する。
export class DetachedBooster extends GameEntity {
  override readonly bcInv = 0.006;
  protected readonly srpCoeff = C.SMALL_DEBRIS_SRP_COEFF;
  protected readonly specificHeat = C.SMALL_DEBRIS_SPECIFIC_HEAT;
  protected readonly bulkDensity = C.SMALL_DEBRIS_BULK_DENSITY;
  protected override get radiatingAreaPerMass(): number {
    return C.SMALL_DEBRIS_RADIATING_AREA_PER_MASS;
  }
  protected readonly maxTemperature = C.SMALL_DEBRIS_MAX_TEMP;
  protected readonly baseHistoryDuration = C.DEFAULT_HISTORY_DURATION;

  private readonly stack: BoosterStack;
  private readonly model: BoosterStageModel;
  private readonly plume: BoosterPlume;
  private readonly boosterScene: THREE.Scene;
  private readonly collisionEnableAt: number;
  private lastBurnRatio = 0;
  private disposed = false;

  constructor(init: DetachedBoosterInit, scene: THREE.Scene) {
    const restored = 'saved' in init;
    const stage = restored ? { ...init.saved.stage, id: init.saved.id } : { ...init.stage };
    const state = restored
      ? kinematicState(
        init.simTime,
        v3(init.saved.r.x, init.saved.r.y, init.saved.r.z),
        v3(init.saved.v.x, init.saved.v.y, init.saved.v.z),
      )
      : init.state;
    const att: Attitude = restored
      ? {
        q: { ...init.saved.q },
        w: v3(init.saved.w.x, init.saved.w.y, init.saved.w.z),
        inertia: v3(1, 1, 0.4),
      }
      : init.att;
    // 接続部のカバーは分離時に爆砕ボルトで切り離されるため、独立した段には残さない。
    const model = buildBoosterStage({ interstageCover: false });
    const root = new THREE.Group();
    // GameEntity.state は段の重心。描画モデルは前端原点なので、その中点をrootへ合わせる。
    const centerZ = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    model.position.z = -centerZ;
    root.add(model);
    super(state, root, scene, att, nextBoosterId(stage.id));

    this.stack = new BoosterStack([stage]);
    this.model = model;
    this.plume = new BoosterPlume(scene);
    this.boosterScene = scene;
    this.collisionEnableAt = restored
      ? (init.saved.collisionEnableAt ?? init.simTime)
      : init.collisionEnableAt;
    this.name = '分離ブースター';
    this.radius = C.BOOSTER_COLLISION_RADIUS;
    this.contactDamageWeight = 0.35;
    this.doPreciseReentry = true;
    this.refreshMass();
    this.collides = true;
  }

  get stage(): BoosterStageState {
    return this.stack.stages[0]!;
  }

  get burning(): boolean {
    return this.thrust !== null;
  }

  // Game のフレーム更新から積分前に呼ぶ。点火状態は操作対象でなくても進み続ける。
  updateBurn(simDt: number): void {
    const massBefore = this.stack.totalMass;
    const result = this.stack.step(simDt);
    this.refreshMass();
    this.lastBurnRatio = result.burnRatio;
    const averageAcceleration = boosterAverageAcceleration(result, massBefore, this.mass);
    if (averageAcceleration <= 0) {
      this.thrust = null;
      return;
    }
    const forward = qRotate(this.att.q, v3(0, 0, 1));
    this.thrust = scale(forward, averageAcceleration);
  }

  private refreshMass(): void {
    this.mass = this.stack.totalMass;
  }

  // 猶予の終端でサブステップを区切る。終端ちょうどの区間までは接触させず、次区間から
  // 掃引することで、猶予中の接触を後から拾うことも期限後を1フレーム遅らせることもない。
  override nextSimulationEventTime(simTime: number): number | null {
    return this.collisionEnableAt > simTime ? this.collisionEnableAt : null;
  }

  override contactsWith(_other: GameEntity, simTime: number): boolean {
    return simTime > this.collisionEnableAt;
  }

  syncBooster(
    fo: FloatingOrigin, displayTime: number, camera: CameraSystem, categoryVisible: boolean, style: RenderStyle,
  ): void {
    super.sync(fo, displayTime);
    this.renderObject.visible &&= categoryVisible;
    const displayState = this.displayState(displayTime);
    const effectAtCurrentTime = Math.abs(displayTime - this.state.t) <= 1e-6;
    if (displayState === null || !this.renderObject.visible || this.thrust === null
      || !effectAtCurrentTime || camera.zoomActive) {
      this.plume.hide();
      return;
    }
    const centerZ = (BOOSTER_STAGE_DIMENSIONS.frontZ + BOOSTER_STAGE_DIMENSIONS.aftZ) / 2;
    const nozzleFromCenter = BOOSTER_STAGE_DIMENSIONS.nozzleExitZ - centerZ;
    const nozzleWorld = add(displayState.r, qRotate(this.att.q, v3(0, 0, nozzleFromCenter)));
    const tailDirection = qRotate(this.att.q, v3(0, 0, -1));
    this.plume.sync({
      position: fo.RtoThreeV3(nozzleWorld),
      direction: new THREE.Vector3(tailDirection.x, tailDirection.y, tailDirection.z),
      intensity: Math.max(0.25, this.lastBurnRatio),
      visible: true,
    }, camera.activeCamera.quaternion, style);
  }

  serialize(): DetachedBoosterSaveData {
    return {
      id: this.id,
      name: this.name,
      kind: 'booster',
      r: { ...this.state.r },
      v: { ...this.state.v },
      q: { ...this.att.q },
      w: { ...this.att.w },
      stage: { ...this.stage, id: this.id },
      collisionEnableAt: this.collisionEnableAt,
    };
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.plume.dispose(this.boosterScene);
    this.model.dispose();
    super.dispose();
  }
}
