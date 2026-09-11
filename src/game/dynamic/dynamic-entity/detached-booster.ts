import * as THREE from 'three/webgpu';
import { v3 } from '../../../math/vec3';
import type { Attitude } from '../../../physics/attitude';
import type { KinematicState } from '../../../physics/kinematic-state';
import { savedAttitude, savedKinematicState, type DetachedBoosterSaveData } from '../../save/save-data';
import { nextBoosterId, type BoosterStage } from '../../player/booster-stack';
import { DetachedBoosterMotion } from './detached-booster-motion';
import {
  DetachedBoosterView, type DetachedBoosterRenderSource,
} from '../../../render/dynamic/dynamic-entity/detached-booster-view';
import type { DynamicViewFrame } from '../../../render/dynamic/dynamic-view';
import { DynamicEntity } from './dynamic-entity';
import type { DynamicEntityKind } from './entity-kind';
import type { OrbitReference } from '../../orbit-reference';

// 表示時刻を「現在」とみなす許容差 [sim s]。過去・未来を映しているフレームでは燃焼を描かない。
const BURN_DISPLAY_EPS = 1e-6;

type DetachedBoosterInit =
  | {
    readonly stage: BoosterStage;
    readonly state: KinematicState;
    readonly att: Attitude;
    readonly collisionEnableAt: number;
  }
  | { readonly saved: DetachedBoosterSaveData; readonly simTime: number };

// 分離ブースターの識別情報、運動、表示を一体として所有する。
export class DetachedBooster extends DynamicEntity {
  public override readonly mapKind: DynamicEntityKind = 'player';
  public override readonly capKind = 'booster';
  public declare readonly motion: DetachedBoosterMotion;

  // 新規の分離は切り離した段と分離時の状態から、再開は saved を simTime 付きの状態として展開して
  // 組む。id は段の id を引き継ぐ。
  public constructor(init: DetachedBoosterInit, scene: THREE.Scene) {
    const restored = 'saved' in init;
    const stage = restored ? { ...init.saved.stage, id: init.saved.id } : { ...init.stage };
    const state = restored ? savedKinematicState(init.saved, init.simTime) : init.state;
    const attitude: Attitude = restored ? savedAttitude(init.saved, v3(1, 1, 0.4)) : init.att;
    const collisionEnableAt = restored
      ? (init.saved.collisionEnableAt ?? init.simTime)
      : init.collisionEnableAt;
    super(
      () => new DetachedBoosterMotion(state, attitude, stage, collisionEnableAt),
      new DetachedBoosterView(scene),
      nextBoosterId(stage.id),
    );
    this.setName('分離ブースター');
  }

  // 噴射炎を描くフレームだけ、その燃焼比を表示入力へ足す。
  protected override renderSource(
    viewFrame: DynamicViewFrame, visible: boolean, active: boolean,
    orbitReference: OrbitReference | undefined,
  ): DetachedBoosterRenderSource {
    const motion = this.motion;
    // 燃焼は積分の先端でしか決まっていないので、その時刻を映しているフレームだけ噴かせる。
    const burning = motion.thrust !== null
      && Math.abs(viewFrame.displayTime - motion.state.t) <= BURN_DISPLAY_EPS;
    return {
      ...super.renderSource(viewFrame, visible, active, orbitReference),
      burnRatio: burning ? motion.burnRatio : null,
    };
  }

  // 運動状態と残存段をセーブ用データへ変換する。
  public override serialize(): DetachedBoosterSaveData {
    const motion = this.motion;
    return {
      id: this.id,
      name: this.name,
      kind: 'booster',
      r: { ...motion.state.r },
      v: { ...motion.state.v },
      q: { ...motion.att.q },
      w: { ...motion.att.w },
      stage: { ...motion.stage, id: this.id },
      collisionEnableAt: motion.collisionEnableAt,
    };
  }
}
