// 計画軌道の折れ線を、そのフレームに宣言された弧のぶんだけ描く。折れ線は宣言の index ごとに
// 使い回すプールとして持ち、宣言から外れた index の線は頂点を持たない状態へ戻す。
import * as THREE from 'three/webgpu';
import { TrajectoryLine } from '../lines/trajectory-line';
import type { CameraFrame } from '../camera/camera-frame';
import type { LineStyle } from '../line-style';
import type { Vec3 } from '../../math/vec3';
import type { DynamicTrajectory } from '../../physics/dynamic-trajectory';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { CelestialFrameSource, FrameTransformSource } from '../lines/celestial-frame-source';

// このフレームに描く折れ線1本。
export interface PlanArcLine {
  readonly trajectory: DynamicTrajectory;
  // 描画区間の下限・上限 [s]。
  readonly from: number;
  readonly to: number;
  // 折れ線が載る座標系。
  readonly frame: ReferenceFrame;
  readonly style: LineStyle;
}

export class PlanPathView {
  private readonly group = new THREE.Group();
  private readonly lines: TrajectoryLine[] = [];
  // 直近の sync で描いた宣言。宣言から外れた index の線を同じ座標系・見た目のまま空にするのと、
  // 点列の読み出しに使う。
  private arcs: readonly PlanArcLine[] = [];

  // 折れ線を載せる group をシーンへ登録する。
  public constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  // 宣言された弧をそれぞれの折れ線へ焼く。displayTime は un-bake に使う表示時刻。
  public sync(
    arcs: readonly PlanArcLine[], displayTime: number, celestialBodies: CelestialFrameSource,
    frameAnchors: FrameAnchorSource, camera: CameraFrame,
  ): void {
    for (let i = 0; i < arcs.length; i++) {
      const arc = arcs[i]!;
      this.lineAt(i, arc.style).sync(
        arc.trajectory, arc.from, arc.to, arc.frame, displayTime, celestialBodies,
        frameAnchors, arc.style, camera,
      );
    }
    // 前のフレームまで描いていて、このフレームは宣言から外れた index の線を空にする。
    for (let i = arcs.length; i < this.arcs.length; i++) {
      const stale = this.arcs[i]!;
      this.lines[i]!.sync(
        null, null, null, stale.frame, displayTime, celestialBodies,
        frameAnchors, stale.style, camera,
      );
    }
    this.arcs = arcs;
  }

  // 直近の sync で描いた折れ線を、当たり判定向けの ECI 点列として弧ごとに読み出す。
  public lineSamples(
    count: number, displayTime: number, frames: FrameTransformSource, frameAnchors: FrameAnchorSource,
  ): readonly (readonly Vec3[])[] {
    return this.arcs.map(
      (arc, i) => this.lines[i]!.samplePoints(count, arc.frame, displayTime, frames, frameAnchors),
    );
  }

  // group をシーンから外し、プールした折れ線を解放する。
  public dispose(): void {
    this.group.removeFromParent();
    for (const line of this.lines) line.dispose();
  }

  // i 番目の折れ線を返す。まだ無ければ style で起こして group へ加える — 破線になるかどうかは
  // 起こすときの style だけが決めるので、その index を最初に描く宣言の style で作る。
  private lineAt(i: number, style: LineStyle): TrajectoryLine {
    while (this.lines.length <= i) {
      const line = new TrajectoryLine(style);
      this.lines.push(line);
      this.group.add(line.line);
    }
    return this.lines[i]!;
  }
}
