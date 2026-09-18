// 直近ノードの実行ガイド: NODE/BURN マーカーと、噴射方向が視界外のときの方位ガイド。
import { KinematicState } from '../../physics/kinematic-state';
import { addScaled, len, norm, sub } from '../../math/vec3';
import { fmtDist, fmtSpeed, fmtTime } from '../../hud/utils';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { MARKER_DIR_DIST, bearingPlacement, directionPlacement, pointPlacement } from '../marker/marker-placement';
import { DIRECTION_GLYPH, ORBIT_POINT_GLYPH, COLOR_MARKER_NODE } from '../marker/marker-identity';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { PlanPath } from './plan-path';
import { THROTTLE_LEVELS } from '../player/throttle';

export class PlanGuide {
  private readonly declarations: MarkerDeclaration[] = [];

  public constructor(private readonly group: MarkerSink) {}

  // 所有するマーカー群を取り除く。
  public dispose(): void { this.group.dispose(); }

  // 直近ノードの NODE・BURN マーカーを同期する。位置と方向は path の表示変換を通す —
  // 同じ計画を描いた折れ線とマーカーが同じ座標系に載っていなければ、線の上に立たない。
  public sync(
    controlled: Controllable | null, simTime: number, camera: CameraFrame, path: PlanPath,
    nowMs: number,
  ): void {
    const declarations = this.declarations;
    declarations.length = 0;
    const node = controlled?.plan.firstNode();
    if (controlled && node) this.pushNodeDeclarations(declarations, controlled, node, simTime, camera, path);
    else this.pushHiddenDeclarations(declarations);
    this.group.sync(declarations, nowMs);
  }

  // NODE・BURN・方位ガイドの宣言を、直近ノードの残り時間と目標速度との差分から積む。
  private pushNodeDeclarations(
    out: MarkerDeclaration[], controlled: Controllable, node: KinematicState, simTime: number,
    camera: CameraFrame, path: PlanPath,
  ): void {
    // NODE マーカー: ノードまでの残り時間を表示する。
    const tRem = node.t - simTime;
    const tLabel = tRem >= 0 ? `T-${fmtTime(tRem)}` : `T+${fmtTime(-tRem)}`;
    const queued = controlled.plan.nodes.length;
    const more = queued > 1 ? ` (+${queued - 1})` : '';

    // BURN マーカー: 目標速度との差分ベクトルを噴射方向として表示する。
    const dvRem = sub(node.v, controlled.motion.state.v);
    const mag = len(dvRem);
    const nodeDist = len(sub(node.r, controlled.motion.state.r));
    const maxAccel = THROTTLE_LEVELS[THROTTLE_LEVELS.length - 1] ?? 1;
    const burnTime = maxAccel > 0 ? mag / maxAccel : 0;
    const shipPos = path.toDisplay(controlled.motion.state.r, simTime);
    const burnDir = path.toDisplayDir(dvRem, simTime);
    const project = camera.project;

    out.push({
      id: 'nd', cls: 'mk-mnode', sym: ORBIT_POINT_GLYPH.maneuverNode,
      ...pointPlacement(path.toDisplay(node.r, node.t), project),
      label: `NODE${more}\nBURN ${fmtTime(burnTime)}\nDIST ${fmtDist(nodeDist)}\nTIME ${tLabel}`,
      priority: MARKER_PRIORITY.MANEUVER_NODE,
    });
    out.push({
      id: 'burn', cls: 'mk-burn', sym: ORBIT_POINT_GLYPH.burnPoint,
      ...directionPlacement(shipPos, burnDir, project),
      label: `BURN ${mag.toFixed(1)} m/s → ${fmtSpeed(len(node.v))}`,
      priority: MARKER_PRIORITY.MANEUVER_NODE,
    });
    // 噴射方向が視界外(背面を含む)なら、敵・弾薬と同じ画面端の方位ガイドを出す。
    const burnPoint = project(addScaled(shipPos, norm(burnDir), MARKER_DIR_DIST));
    const placement = bearingPlacement(burnPoint, camera.viewport);
    out.push({
      id: 'burn-bearing', cls: 'mk-dir', sym: DIRECTION_GLYPH.bearing,
      x: placement?.x ?? 0, y: placement?.y ?? 0, front: placement !== null,
      rotationDeg: placement?.rotationDeg, opacity: 0.7, color: COLOR_MARKER_NODE,
      priority: MARKER_PRIORITY.NONE,
    });
  }

  // 実行するノードが無いフレームに、3つのマーカーを伏せたままにする宣言。
  private pushHiddenDeclarations(out: MarkerDeclaration[]): void {
    for (const [id, cls, sym] of [
      ['nd', 'mk-mnode', ORBIT_POINT_GLYPH.maneuverNode],
      ['burn', 'mk-burn', ORBIT_POINT_GLYPH.burnPoint],
      ['burn-bearing', 'mk-dir', DIRECTION_GLYPH.bearing],
    ] as const) {
      out.push({ id, cls, sym, x: 0, y: 0, front: false, priority: MARKER_PRIORITY.NONE });
    }
  }
}
