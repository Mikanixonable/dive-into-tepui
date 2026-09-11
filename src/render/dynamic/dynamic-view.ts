import * as THREE from 'three/webgpu';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CelestialBody } from '../../physics/celestial-body';
import type { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { Quat } from '../../math/quat';
import type { Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import { orbitalElementsOf } from '../../physics/elements';
import { disposeOwnedRenderResources } from '../dispose-owned-render-resources';
import type { EntityVisualSettings } from '../entity-visual-settings';
import type { LineStyle } from '../line-style';
import type { RenderStyle } from '../render-style';
import type { CameraFrame } from '../camera/camera-frame';
import { EllipseLine } from '../lines/ellipse-line';
import { TargetRelativeLine } from '../lines/target-relative-line';
import { TrajectoryLine } from '../lines/trajectory-line';
import type { CelestialFrameSource } from '../lines/celestial-frame-source';
import type { InstancedPools } from './instanced-pools';
import { syncThermalState } from '../thermal-emissive';

// 熱による発光の表示入力。温度と過熱の振幅は [K]。
export interface DynamicThermalSource {
  readonly temperature: number;
  readonly deviation: number;
  readonly emissivity: number;
}

// 1体ぶんの、そのフレームの表示入力。種別ごとの View は、これへ自分が読む値を足した面で受ける。
export interface DynamicRenderSource {
  readonly id: string;
  readonly name: string;
  // このフレームに本体を出すか。
  readonly visible: boolean;
  readonly alive: boolean;
  // 表示時刻の運動状態。引けないフレームは null。
  stateAt(t: number): KinematicState | null;
  // 現在の姿勢。
  readonly attitude: Quat;
  // 熱の表現。比熱を持つ個体だけが値を持ち、それ以外は null。
  readonly thermal: DynamicThermalSource | null;
}

// そのフレームの、全個体で共有する表示入力。
export interface DynamicViewFrame {
  readonly displayTime: number;
  readonly camera: CameraFrame;
  readonly style: RenderStyle;
  readonly visual: EntityVisualSettings;
  readonly pools: InstancedPools;
}

// 線の形状の基準になる、1体ぶんの時刻問い合わせ。
interface DynamicStateSource {
  readonly state: KinematicState;
  stateAt(t: number, celestialBodies?: CelestialFrameSource): KinematicState | null;
}

// 線として焼く軌跡と、その時刻問い合わせ。
interface DynamicLineSource extends DynamicStateSource {
  readonly predicted: DynamicTrajectory | null;
  readonly actual: DynamicTrajectory;
}

export interface DynamicLineDisplay {
  readonly orbit:
    | { readonly kind: 'ellipse'; readonly style: LineStyle; readonly center: CelestialBody | null }
    | { readonly kind: 'relative'; readonly style: LineStyle; readonly target: DynamicStateSource }
    | null;
  readonly predicted: LineStyle | null;
  readonly actual: LineStyle | null;
}

export interface DynamicLineSamples {
  readonly method: 'analytic' | 'numeric';
  readonly points: readonly Vec3[];
}

type OrbitLineResource =
  | { readonly kind: 'ellipse'; readonly line: EllipseLine }
  | { readonly kind: 'relative'; readonly line: TargetRelativeLine };

// 種別ごとの View の基底。1体ぶんの表示ツリー、オーバーレイ資源、再構築回避用キャッシュを所有する。
// S は種別ごとの表示入力で、既定は全個体に共通する面。
export abstract class DynamicView<S extends DynamicRenderSource = DynamicRenderSource> {
  private orbitLineValue: OrbitLineResource | null = null;
  private predictedLineValue: TrajectoryLine | null = null;
  private actualLineValue: TrajectoryLine | null = null;

  // object を表示ツリーの根として所有する。addToScene なら scene へ登録する。
  public constructor(
    public readonly object: THREE.Object3D,
    protected readonly scene?: THREE.Scene,
    addToScene = true,
  ) {
    if (addToScene) this.scene?.add(this.object);
  }

  // 個体の表示入力を、所有する THREE モデルへ同期する。
  public sync(source: S, viewFrame: DynamicViewFrame): void {
    const displayed = source.alive ? this.place(source, viewFrame) : null;
    if (!source.alive) this.object.visible = false;
    this.syncModel(source, displayed, viewFrame);
  }

  // 表示時刻の状態があれば、可視性・位置・姿勢・熱表現を THREE ルートへ適用する。
  protected place(source: DynamicRenderSource, viewFrame: DynamicViewFrame): KinematicState | null {
    const state = source.stateAt(viewFrame.displayTime);
    this.object.visible = state !== null && source.visible;
    if (state === null) return null;
    // 位置は表示時刻の状態から、姿勢は現在の値から置く。
    this.object.position.copy(viewFrame.camera.floatingOrigin.RtoThreeV3(state.r));
    const q = source.attitude;
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    // 熱の表現を持つ個体は、発光を温度へ合わせる。
    const thermal = source.thermal;
    if (thermal !== null) {
      syncThermalState(this.object, thermal.temperature, thermal.deviation, thermal.emissivity);
    }
    return state;
  }

  // 種別固有の表示を同期する。displayed は表示時刻の状態で、本体を置けなかったフレームは null。
  protected syncModel(
    _source: S, _displayed: KinematicState | null, _viewFrame: DynamicViewFrame,
  ): void {
  }

  // 軌道線の資源があれば、scene から外して破棄する。
  private disposeOrbitLine(): void {
    if (this.orbitLineValue === null) return;
    this.scene?.remove(this.orbitLineValue.line.line);
    this.orbitLineValue.line.dispose();
    this.orbitLineValue = null;
  }

  // 宣言された種類の軌道線資源へ差し替え、新しい資源を返す。
  private swapOrbitLine<T extends OrbitLineResource>(resource: T): T {
    this.disposeOrbitLine();
    this.scene?.add(resource.line.line);
    this.orbitLineValue = resource;
    return resource;
  }

  // 宣言された軌道表現の種類へ資源を揃え、そのフレームの形状と見た目を反映する。
  private syncOrbitLine(
    display: DynamicLineDisplay['orbit'],
    motion: DynamicLineSource, displayTime: number, celestialBodies: CelestialFrameSource,
    camera: CameraFrame, anchors: FrameAnchorSource,
  ): void {
    if (display === null) {
      this.disposeOrbitLine();
      return;
    }
    const state = motion.stateAt(displayTime, celestialBodies);
    // 相対線と解析楕円では形状の基準が異なるので、宣言の判別子で経路を分ける。
    if (display.kind === 'relative') {
      // 相対線は線だけを消せないので、表示時刻の状態を引けないフレームは資源ごと畳む。
      if (state === null) {
        this.disposeOrbitLine();
        return;
      }
      const orbitLine = this.orbitLineValue?.kind === 'relative'
        ? this.orbitLineValue
        : this.swapOrbitLine({ kind: 'relative', line: new TargetRelativeLine(display.style) });
      const target = display.target.stateAt(displayTime, celestialBodies)?.r ?? display.target.state.r;
      orbitLine.line.sync(state.r, target, display.style, camera);
      return;
    }
    const orbitLine = this.orbitLineValue?.kind === 'ellipse'
      ? this.orbitLineValue
      : this.swapOrbitLine({ kind: 'ellipse', line: new EllipseLine(display.style) });
    const elements = state === null ? null : orbitalElementsOf(
      state,
      display.center ?? strongestAttractor(state.r, anchors.bodies, anchors.bodiesPivot),
      anchors.bodiesPivot,
    );
    orbitLine.line.sync(elements, display.style, camera);
  }

  // 予測・過去軌跡の線 line があれば、scene から外して破棄する。
  private disposeTrajectoryLine(line: TrajectoryLine | null): void {
    if (line === null) return;
    this.scene?.remove(line.line);
    line.dispose();
  }

  // style が null なら current を破棄して null を返す。そうでなければ線を用意して [from, to] の
  // 軌跡を焼き、その線を返す。
  private syncTrajectoryLine(
    current: TrajectoryLine | null, style: LineStyle | null,
    trajectory: DynamicTrajectory | null, from: number, to: number | null,
    frame: ReferenceFrame, displayTime: number, celestialBodies: CelestialFrameSource,
    camera: CameraFrame, anchors: FrameAnchorSource,
  ): TrajectoryLine | null {
    if (style === null) {
      this.disposeTrajectoryLine(current);
      return null;
    }
    const line = current ?? new TrajectoryLine(style);
    if (current === null) this.scene?.add(line.line);
    line.sync(trajectory, from, to, frame, displayTime, celestialBodies, anchors, style, camera);
    return line;
  }

  // このフレームに必要な3種の線を一括して描画資源へ同期する。
  public syncLines(
    display: DynamicLineDisplay,
    motion: DynamicLineSource, frame: ReferenceFrame, simTime: number, displayTime: number,
    pastDuration: number, predictedTo: number | null, celestialBodies: CelestialFrameSource,
    camera: CameraFrame, anchors: FrameAnchorSource,
  ): void {
    // 過去線は表示窓の過去側、予測線は現在から予測終端までを同じ参照系で同期する。
    this.predictedLineValue = this.syncTrajectoryLine(
      this.predictedLineValue, display.predicted, motion.predicted, simTime, predictedTo,
      frame, displayTime, celestialBodies, camera, anchors,
    );
    this.actualLineValue = this.syncTrajectoryLine(
      this.actualLineValue, display.actual, motion.actual, simTime - pastDuration, simTime,
      frame, displayTime, celestialBodies, camera, anchors,
    );
    this.syncOrbitLine(
      display.orbit, motion, displayTime, celestialBodies, camera, anchors,
    );
  }

  // 現在描画している線を、当たり判定用の ECI 点列として読み出す。
  public lineSamples(count: number): DynamicLineSamples | null {
    // 解析線を優先し、積分線だけのときは過去→未来の順に連結する。
    if (this.orbitLineValue !== null) {
      return { method: 'analytic', points: this.orbitLineValue.line.samplePoints(count) };
    }
    if (this.predictedLineValue === null && this.actualLineValue === null) return null;
    return {
      method: 'numeric',
      points: [
        ...(this.actualLineValue?.samplePoints(count) ?? []),
        ...(this.predictedLineValue?.samplePoints(count) ?? []),
      ],
    };
  }

  // この View が所有する資源を解放する。以後この View は使えない。
  public dispose(): void {
    this.disposeOrbitLine();
    this.disposeTrajectoryLine(this.predictedLineValue);
    this.predictedLineValue = null;
    this.disposeTrajectoryLine(this.actualLineValue);
    this.actualLineValue = null;
    this.scene?.remove(this.object);
    disposeOwnedRenderResources(this.object);
  }
}
