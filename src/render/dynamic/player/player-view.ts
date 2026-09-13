import * as THREE from 'three/webgpu';
import type { Vec3 } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { memoParseIndependent } from '../baked-model';
import {
  DynamicView, type DynamicRenderSource, type DynamicViewFrame,
} from '../dynamic-view';
import { AttachedBoostersView, type AttachedBoostersDisplay } from './attached-boosters-view';
import { BeltView, type BeltNodes } from './belt-view';
import { FoldingPanelsView, type RadiatorDisplay, type SolarDeploy } from './folding-panels-view';
import { RcsEffects } from './rcs-effects';
import { ReentryEffects } from './reentry-effects';
import { ThrustEffects } from './thrust-effects';
import playerData from '../../../assets/models/player.json';

const parsePlayer = memoParseIndependent<THREE.Group>(playerData);

// 自機のモデルを複製する。機首は +Z。
export function buildPlayerShip(): THREE.Group {
  return parsePlayer();
}

// 自機1体ぶんの、そのフレームの表示入力。
export interface PlayerRenderSource extends DynamicRenderSource {
  // 現在時刻の実状態。表示時刻がゴーストかどうかの判定に使う。
  readonly state: KinematicState;
  // 操作対象か。照準ズーム中に自機を隠すかがこれで決まる。
  readonly active: boolean;
  // マニューバ噴射の加速度 [m/s^2](ECI)。噴射していなければ null。
  readonly thrustAcceleration: Vec3 | null;
  readonly maximumAcceleration: number; // 全開時の加速度 [m/s^2]
  readonly torque: Vec3; // 機体座標系の指令角加速度 [rad/s^2]
  readonly dynamicPressure: number; // 動圧 [Pa]
  readonly boosters: AttachedBoostersDisplay;
  readonly belt: BeltNodes;
  readonly magsLeft: number; // 残マガジン数
  readonly solar: SolarDeploy;
  readonly radiator: RadiatorDisplay;
}

// 自機の全モデル、エフェクト、可動部を所有する。
export class PlayerView extends DynamicView<PlayerRenderSource> {
  private readonly thrustEffects: ThrustEffects;
  private readonly rcsEffects: RcsEffects;
  private readonly reentryEffects: ReentryEffects;
  private readonly belt: BeltView;
  private readonly panels: FoldingPanelsView;
  private readonly boosters: AttachedBoostersView;

  // 自機モデルと、その子表示・噴射資源を組み立てる。beltLinkCount はベルトのリンクメッシュ数で、
  // 供給される節点の本数と揃える。
  public constructor(
    scene: THREE.Scene,
    ownerId: string,
    beltLinkCount: number,
  ) {
    // 船体を根にして、形状に密着する子表示を同じツリーへ結び付ける。
    const model = buildPlayerShip();
    super(model, scene);
    this.thrustEffects = new ThrustEffects(scene, ownerId);
    this.rcsEffects = new RcsEffects(scene, ownerId);
    this.reentryEffects = new ReentryEffects(scene);
    this.belt = new BeltView(model, beltLinkCount);
    this.panels = new FoldingPanelsView(model);
    // scene 直下へ出る噴射も、この View の寿命に揃える。
    this.boosters = new AttachedBoostersView(scene, model);
  }

  // 供給された表示入力を、船体の全表示資源へ一括して反映する。
  protected override syncModel(
    source: PlayerRenderSource,
    displayed: KinematicState | null,
    viewFrame: DynamicViewFrame,
  ): void {
    // 表示時刻の状態を各エフェクトへ渡し、引けなかったフレームは null で畳ませる。
    const origin = viewFrame.camera.floatingOrigin;
    const effectPosition = displayed?.r ?? null;
    const effectVisible = this.object.visible;
    const cameraQuat = viewFrame.camera.camera.quaternion;
    const zoomActive = viewFrame.camera.zoomed;

    // 船外へ出るブースター・推力・RCS・再突入表現は同じ可視性に揃える。
    this.boosters.sync(
      origin,
      effectPosition,
      viewFrame.displayTime,
      source.state.t,
      source.attitude,
      source.boosters,
      effectVisible,
      cameraQuat,
      zoomActive,
      viewFrame.style,
    );
    this.thrustEffects.sync(
      origin,
      effectPosition,
      source.thrustAcceleration,
      source.maximumAcceleration,
      effectVisible,
      cameraQuat,
      zoomActive,
      viewFrame.style,
      viewFrame.displayTime,
    );
    this.rcsEffects.sync(
      origin,
      effectPosition,
      source.torque,
      source.attitude,
      effectVisible,
      cameraQuat,
      zoomActive,
      viewFrame.displayTime,
    );
    this.reentryEffects.sync(
      origin,
      displayed,
      source.dynamicPressure,
      effectVisible,
      cameraQuat,
    );
    // 船体に属する可動部を供給された値へ合わせる。
    this.belt.sync(source.magsLeft, source.belt);
    this.panels.sync(source.solar, source.radiator);
    if (source.active && zoomActive) this.object.visible = false;
  }

  // 自機固有の子表示を片付けてから、共通 View の THREE 資源を破棄する。
  public override dispose(): void {
    this.boosters.dispose();
    this.thrustEffects.dispose(this.scene!);
    this.rcsEffects.dispose(this.scene!);
    this.reentryEffects.dispose(this.scene!);
    super.dispose();
  }
}
