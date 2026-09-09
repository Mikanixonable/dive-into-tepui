import * as THREE from 'three/webgpu';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { KinematicState } from '../../physics/kinematic-state';
import type { CelestialBody } from '../../physics/celestial-body';
import { strongestAttractor } from '../../physics/attractor';
import { orbitalElementsOf } from '../../physics/elements';
import { disposeOwnedRenderResources } from '../../render/dispose-owned-render-resources';
import type { GraphicsSettingsData } from '../../render/graphics-settings';
import type { LineStyle } from '../../render/line-style';
import type { RenderStyle } from '../../render/render-style';
import type { CameraSystem } from '../camera/camera-system';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import { EllipseLine } from '../lines/ellipse-line';
import { TargetRelativeLine } from '../lines/target-relative-line';
import { TrajectoryLine } from '../lines/trajectory-line';
import {
  EquatorNodeMarkerPair, type EquatorNodeInputs,
} from '../marker/equator-node-marker-pair';
import type { ObjectPickable } from '../pickable/object-pickable';
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
  readonly frameAnchors: FrameAnchorSource;
  readonly timeLabel: TimeLabelSetting;
}

interface DynamicStateSource {
  readonly state: KinematicState;
  stateAt(t: number, celestialBodies?: CelestialBodies): KinematicState | null;
}

type OrbitLine =
  | { readonly kind: 'ellipse'; readonly line: EllipseLine; readonly center: CelestialBody | null }
  | { readonly kind: 'relative'; readonly line: TargetRelativeLine; readonly target: DynamicStateSource };

// 1体ぶんの表示ツリー、表示専用状態、オーバーレイと同期処理をすべて所有する。
export class DynamicView {
  public showTrajectoryLine = false;
  public orbitLineColor: string | number = 0xffffff;

  private orbitLineValue: OrbitLine | null = null;
  private predictedLineValue: TrajectoryLine | null = null;
  private actualLineValue: TrajectoryLine | null = null;
  private equatorNodes: EquatorNodeMarkerPair | null = null;

  public constructor(
    public readonly object: THREE.Object3D,
    protected readonly scene?: THREE.Scene,
    addToScene = true,
  ) {
    if (addToScene) this.scene?.add(this.object);
  }

  public get orbitLine(): OrbitLine | null { return this.orbitLineValue; }
  public get predictedLine(): TrajectoryLine | null { return this.predictedLineValue; }
  public get actualLine(): TrajectoryLine | null { return this.actualLineValue; }

  public sync(identity: DynamicViewIdentity, motion: DynamicMotion, context: DynamicViewFrame): void {
    const visible = identity.mapKind === null || context.visibilityPolicy === null
      || context.visibilityPolicy.entity(identity.mapKind, identity.id === context.activeId).category;
    const displayed = motion.alive
      ? this.place(motion, context.displayTime, context.floatingOrigin, visible)
      : null;
    this.syncModel(motion, displayed, context);
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
    _motion: DynamicMotion, _displayed: KinematicState | null, _context: DynamicViewFrame,
  ): void {
  }

  public showEllipseLine(style: LineStyle, center: CelestialBody | null): void {
    const kept = this.orbitLineValue?.kind === 'ellipse' ? this.orbitLineValue.line : null;
    if (kept !== null) {
      kept.setStyle(style);
      this.orbitLineValue = { kind: 'ellipse', line: kept, center };
      return;
    }
    this.hideOrbitLine();
    const line = new EllipseLine(style);
    this.scene?.add(line.line);
    this.orbitLineValue = { kind: 'ellipse', line, center };
  }

  public showTargetRelativeLine(style: LineStyle, target: DynamicStateSource): void {
    const kept = this.orbitLineValue?.kind === 'relative' ? this.orbitLineValue.line : null;
    if (kept !== null) {
      kept.setStyle(style);
      this.orbitLineValue = { kind: 'relative', line: kept, target };
      return;
    }
    this.hideOrbitLine();
    const line = new TargetRelativeLine(style);
    this.scene?.add(line.line);
    this.orbitLineValue = { kind: 'relative', line, target };
  }

  public hideOrbitLine(): void {
    if (this.orbitLineValue === null) return;
    this.scene?.remove(this.orbitLineValue.line.line);
    this.orbitLineValue.line.dispose();
    this.orbitLineValue = null;
  }

  public syncOrbitLine(
    motion: DynamicMotion, displayTime: number, celestialBodies: CelestialBodies,
    floatingOrigin: FloatingOrigin, camera: THREE.Camera, anchors: FrameAnchorSource,
  ): void {
    const orbitLine = this.orbitLineValue;
    if (orbitLine === null) return;
    const state = motion.stateAt(displayTime, celestialBodies);
    if (state === null) {
      orbitLine.line.hide();
      return;
    }
    if (orbitLine.kind === 'relative') {
      const target = orbitLine.target.stateAt(displayTime, celestialBodies)?.r ?? orbitLine.target.state.r;
      orbitLine.line.sync(state.r, target, floatingOrigin, camera);
      return;
    }
    const center = orbitLine.center ?? strongestAttractor(state.r, anchors.bodies, anchors.bodiesPivot);
    const elements = orbitalElementsOf(state, center, anchors.bodiesPivot);
    if (elements === null) orbitLine.line.hide();
    else orbitLine.line.sync(elements, floatingOrigin, camera);
  }

  public showPredictedLine(motion: DynamicMotion, style: LineStyle): void {
    motion.trajectoryReader = true;
    if (this.predictedLineValue !== null) {
      this.predictedLineValue.setStyle(style);
      return;
    }
    this.predictedLineValue = new TrajectoryLine(style);
    this.scene?.add(this.predictedLineValue.line);
  }

  public hidePredictedLine(motion: DynamicMotion): void {
    motion.trajectoryReader = false;
    if (this.predictedLineValue === null) return;
    this.scene?.remove(this.predictedLineValue.line);
    this.predictedLineValue.dispose();
    this.predictedLineValue = null;
  }

  public showActualLine(style: LineStyle): void {
    if (this.actualLineValue !== null) {
      this.actualLineValue.setStyle(style);
      return;
    }
    this.actualLineValue = new TrajectoryLine(style);
    this.scene?.add(this.actualLineValue.line);
  }

  public hideActualLine(): void {
    if (this.actualLineValue === null) return;
    this.scene?.remove(this.actualLineValue.line);
    this.actualLineValue.dispose();
    this.actualLineValue = null;
  }

  public syncTrajectoryLines(
    motion: DynamicMotion, frame: ReferenceFrame, simTime: number, displayTime: number,
    pastDuration: number, predictedTo: number | null, celestialBodies: CelestialBodies,
    floatingOrigin: FloatingOrigin, camera: THREE.Camera, anchors: FrameAnchorSource,
  ): void {
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
  }

  public updateEquatorNodes(
    identity: DynamicViewIdentity, motion: DynamicMotion, inputs: EquatorNodeInputs, controlled: boolean,
  ): void {
    const visible = motion.alive
      && (identity.showsEquatorNodesAlways || controlled || motion.navTargetReader);
    if (!visible) {
      this.equatorNodes?.retire();
      return;
    }
    (this.equatorNodes ??= new EquatorNodeMarkerPair(identity.id, inputs.markers))
      .update(motion, identity.name, inputs);
  }

  public equatorNodePickables(): readonly ObjectPickable[] {
    return this.equatorNodes?.pickables() ?? [];
  }

  public dispose(): void {
    this.equatorNodes?.dispose();
    this.hideOrbitLine();
    if (this.predictedLineValue !== null) {
      this.scene?.remove(this.predictedLineValue.line);
      this.predictedLineValue.dispose();
      this.predictedLineValue = null;
    }
    this.hideActualLine();
    this.scene?.remove(this.object);
    disposeOwnedRenderResources(this.object);
  }
}
