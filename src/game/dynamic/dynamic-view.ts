import * as THREE from 'three/webgpu';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Vec3 } from '../../math/vec3';
import { strongestAttractor } from '../../physics/attractor';
import { orbitalElementsOf } from '../../physics/elements';
import { disposeOwnedRenderResources } from '../../render/dispose-owned-render-resources';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { LineStyle } from '../../render/line-style';
import type { RenderStyle } from '../../render/render-style';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import { EllipseLine } from '../lines/ellipse-line';
import { TargetRelativeLine } from '../lines/target-relative-line';
import { TrajectoryLine } from '../lines/trajectory-line';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { OrbitReference } from '../orbit-reference';
import type { DynamicEntityKind } from './dynamic-entity/entity-kind';
import type { InstancedPools } from './instanced-pools';
import type { DynamicMotion } from './dynamic-motion';
import { syncThermalState } from '../../render/thermal-emissive';

export interface DynamicViewIdentity {
  readonly id: string;
  readonly name: string;
  readonly mapKind: DynamicEntityKind | null;
  readonly showsEquatorNodesAlways: boolean;
}

export interface DynamicViewFrame {
  readonly floatingOrigin: FloatingOrigin;
  readonly displayTime: number;
  readonly activeId: string | null;
  readonly visibilityPolicy: MapVisibilityPolicy | null;
  readonly pools: InstancedPools;
  readonly cameraSystem: CameraSystem;
  readonly style: RenderStyle;
  readonly graphics: GraphicsSettingsData;
  readonly orbitReference: OrbitReference | undefined;
}

interface DynamicStateSource {
  readonly state: KinematicState;
  stateAt(t: number, celestialBodies?: CelestialBodies): KinematicState | null;
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
  readonly method: 'analytic' | 'predicted';
  readonly points: readonly Vec3[];
}

type OrbitLineResource =
  | { readonly kind: 'ellipse'; readonly line: EllipseLine }
  | { readonly kind: 'relative'; readonly line: TargetRelativeLine };

// 1体ぶんの表示ツリー、オーバーレイ資源、再構築回避用キャッシュを所有する。
export class DynamicView {
  private orbitLineValue: OrbitLineResource | null = null;
  private predictedLineValue: TrajectoryLine | null = null;
  private actualLineValue: TrajectoryLine | null = null;

  public constructor(
    public readonly object: THREE.Object3D,
    protected readonly scene?: THREE.Scene,
    addToScene = true,
  ) {
    if (addToScene) this.scene?.add(this.object);
  }

  // 個体の表示入力を、モデルと所有する DOM マーカーへ同期する。
  public sync(identity: DynamicViewIdentity, motion: DynamicMotion, context: DynamicViewFrame): void {
    const visible = dynamicEntityVisible(identity, context);
    const displayed = motion.alive
      ? this.place(motion, context.displayTime, context.floatingOrigin, visible)
      : null;
    if (!motion.alive) this.object.visible = false;
    this.syncModel(identity, motion, displayed, context);
  }

  protected place(
    motion: DynamicMotion, displayTime: number, floatingOrigin: FloatingOrigin, visible: boolean,
  ): KinematicState | null {
    const state = motion.stateAt(displayTime);
    this.object.visible = state !== null && visible;
    if (state === null) return null;
    this.object.position.copy(floatingOrigin.RtoThreeV3(state.r));
    this.object.quaternion.set(motion.att.q.x, motion.att.q.y, motion.att.q.z, motion.att.q.w);
    if (motion.specificHeat > 0) {
      syncThermalState(this.object, motion.temperature, motion.thermalDeviation, motion.emissivity);
    }
    return state;
  }

  protected syncModel(
    _identity: DynamicViewIdentity, _motion: DynamicMotion,
    _displayed: KinematicState | null, _context: DynamicViewFrame,
  ): void {
  }

  private disposeOrbitLine(): void {
    if (this.orbitLineValue === null) return;
    this.scene?.remove(this.orbitLineValue.line.line);
    this.orbitLineValue.line.dispose();
    this.orbitLineValue = null;
  }

  private syncOrbitLine(
    display: DynamicLineDisplay['orbit'],
    motion: DynamicMotion, displayTime: number, celestialBodies: CelestialBodies,
    floatingOrigin: FloatingOrigin, camera: THREE.Camera, anchors: FrameAnchorSource,
  ): void {
    if (display === null) {
      this.disposeOrbitLine();
      return;
    }
    if (this.orbitLineValue?.kind !== display.kind) {
      this.disposeOrbitLine();
      if (display.kind === 'ellipse') {
        const line = new EllipseLine(display.style);
        this.scene?.add(line.line);
        this.orbitLineValue = { kind: 'ellipse', line };
      } else {
        const line = new TargetRelativeLine(display.style);
        this.scene?.add(line.line);
        this.orbitLineValue = { kind: 'relative', line };
      }
    } else {
      this.orbitLineValue.line.setStyle(display.style);
    }
    const orbitLine = this.orbitLineValue;
    if (orbitLine === null) return;
    const state = motion.stateAt(displayTime, celestialBodies);
    if (state === null) {
      orbitLine.line.hide();
      return;
    }
    if (display.kind === 'relative' && orbitLine.kind === 'relative') {
      const target = display.target.stateAt(displayTime, celestialBodies)?.r ?? display.target.state.r;
      orbitLine.line.sync(state.r, target, floatingOrigin, camera);
      return;
    }
    if (display.kind !== 'ellipse' || orbitLine.kind !== 'ellipse') return;
    const center = display.center ?? strongestAttractor(state.r, anchors.bodies, anchors.bodiesPivot);
    const elements = orbitalElementsOf(state, center, anchors.bodiesPivot);
    if (elements === null) orbitLine.line.hide();
    else orbitLine.line.sync(elements, floatingOrigin, camera);
  }

  private syncTrajectoryLine(
    current: TrajectoryLine | null, style: LineStyle | null,
  ): TrajectoryLine | null {
    if (style === null) {
      if (current !== null) {
        this.scene?.remove(current.line);
        current.dispose();
      }
      return null;
    }
    if (current !== null) {
      current.setStyle(style);
      return current;
    }
    const line = new TrajectoryLine(style);
    this.scene?.add(line.line);
    return line;
  }

  // このフレームに必要な3種の線を一括して描画資源へ同期する。
  public syncLines(
    display: DynamicLineDisplay,
    motion: DynamicMotion, frame: ReferenceFrame, simTime: number, displayTime: number,
    pastDuration: number, predictedTo: number | null, celestialBodies: CelestialBodies,
    floatingOrigin: FloatingOrigin, camera: THREE.Camera, anchors: FrameAnchorSource,
  ): void {
    this.predictedLineValue = this.syncTrajectoryLine(this.predictedLineValue, display.predicted);
    this.actualLineValue = this.syncTrajectoryLine(this.actualLineValue, display.actual);
    if (this.predictedLineValue !== null) {
      this.predictedLineValue.syncGeometry(
        motion.predicted, simTime, predictedTo, frame, celestialBodies, anchors);
      this.predictedLineValue.syncTransform(frame, displayTime, celestialBodies, floatingOrigin, anchors);
      this.predictedLineValue.sync(camera);
    }
    if (this.actualLineValue !== null) {
      this.actualLineValue.syncGeometry(
        motion.actual, simTime - pastDuration, simTime, frame, celestialBodies, anchors);
      this.actualLineValue.syncTransform(frame, displayTime, celestialBodies, floatingOrigin, anchors);
      this.actualLineValue.sync(camera);
    }
    this.syncOrbitLine(
      display.orbit, motion, displayTime, celestialBodies, floatingOrigin, camera, anchors,
    );
  }

  // 現在描画している線を、当たり判定用の ECI 点列として読み出す。
  public lineSamples(
    count: number, frame: ReferenceFrame, displayTime: number,
    celestialBodies: CelestialBodies, anchors: FrameAnchorSource,
  ): DynamicLineSamples | null {
    if (this.orbitLineValue !== null) {
      return { method: 'analytic', points: this.orbitLineValue.line.samplePoints(count) };
    }
    if (this.predictedLineValue === null && this.actualLineValue === null) return null;
    return {
      method: 'predicted',
      points: [
        ...(this.actualLineValue?.samplePoints(
          count, frame, displayTime, celestialBodies.frames, anchors,
        ) ?? []),
        ...(this.predictedLineValue?.samplePoints(
          count, frame, displayTime, celestialBodies.frames, anchors,
        ) ?? []),
      ],
    };
  }

  // この View が所有する THREE / DOM 資源を解放する。
  public dispose(): void {
    this.disposeOrbitLine();
    if (this.predictedLineValue !== null) {
      this.scene?.remove(this.predictedLineValue.line);
      this.predictedLineValue.dispose();
      this.predictedLineValue = null;
    }
    this.actualLineValue = this.syncTrajectoryLine(this.actualLineValue, null);
    this.scene?.remove(this.object);
    disposeOwnedRenderResources(this.object);
  }
}

// Entity と View が同じ可視判定を使うための、1フレーム入力だけから決まる判定。
export function dynamicEntityVisible(
  identity: DynamicViewIdentity, context: DynamicViewFrame,
): boolean {
  return identity.mapKind === null || context.visibilityPolicy === null
    || context.visibilityPolicy.entity(identity.mapKind, identity.id === context.activeId).category;
}
