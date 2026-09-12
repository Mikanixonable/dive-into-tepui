// 直近ノードの実行ガイド: 実行時刻を過ぎたノードの消化、接近・達成の通知、NODE/BURN マーカー。
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements, orbitalElementsOf } from '../../physics/elements';
import { strongestAttractor } from '../../physics/attractor';
import type { CelestialBody } from '../../physics/celestial-body';
import { addScaled, dot, len, norm, sub } from '../../math/vec3';
import type { Notifier } from '../../hud/notifier';
import { fmtDist, fmtSpeed, fmtTime } from '../../hud/utils';
import { UiSfx } from '../../audio/sfx/ui-sfx';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { MarkerDeclaration } from '../../marker/marker-declaration';
import type { MarkerSink } from '../../marker/marker-sink';
import { MARKER_PRIORITY } from '../marker/marker-priority';
import { MARKER_DIR_DIST, bearingPlacement, directionPlacement, pointPlacement } from '../marker/marker-placement';
import { DIRECTION_GLYPH, ORBIT_POINT_GLYPH, COLOR_MARKER_NODE } from '../marker/marker-identity';
import type { Controllable } from '../dynamic/dynamic-entity/controllable';
import type { PlanPath } from './plan-path';
import { THROTTLE_LEVELS } from '../player/throttle';
import { NODE_APPROACH_LEAD } from './plan';

// マニューバ達成判定(計画軌道への接近許容)
const NODE_TOL_SMA = 0.02 / 3; // 長半径の相対誤差
const NODE_TOL_ECC = 0.02 / 3; // 離心率差
const NODE_TOL_PLANE_DEG = 2.0 / 3; // 軌道面の角度差 [deg]

// 実行時刻をこれだけ過ぎたノードは計画から落とす [s]。多少の遅れなら噴射できる猶予。
const NODE_EXPIRE_GRACE = 60;

export class PlanGuide {
  // 通知済みのノード。ノードは編集のたびに別インスタンスへ置き換わるので、同一性の比較が
  // そのまま「同じノードについて既に通知したか」の判定になる。
  private approachNotified: KinematicState | null = null;
  private achievedNotified: KinematicState | null = null;

  private readonly declarations: MarkerDeclaration[] = [];

  constructor(
    private readonly _notifier: Notifier,
    private readonly _uiSfx: UiSfx,
    private readonly group: MarkerSink,
  ) {
  }

  // 所有するマーカー群を取り除く。
  dispose(): void { this.group.dispose(); }

  // 実行時刻を過ぎたノードを計画から落とし、直近ノードへの接近と計画軌道の達成を
  // ノードごとに一度だけ通知する。操作対象がいなければ何もしない。
  update(controlled: Controllable | null, simTime: number, celestialBodies: readonly CelestialBody[]): void {
    if (!controlled) return;
    const plan = controlled.plan;
    plan.consumeNodesUpTo(simTime - NODE_EXPIRE_GRACE, controlled.motion.state);

    const node = plan.firstNode();
    // 実行の窓に入るまでは通知しない。窓の手前では操作対象はまだ噴射前の軌道にいるので、
    // 目標軌道との近さを見ても達成の判定にならない。
    if (node && simTime >= node.t - NODE_APPROACH_LEAD) {
      this.notifyApproach(node);
      this.notifyAchieved(node, controlled, celestialBodies, simTime);
    }
  }

  // 直近ノードの NODE・BURN マーカーを同期する。位置と方向は path の表示変換を通す —
  // 同じ計画を描いた折れ線とマーカーが同じ座標系に載っていなければ、線の上に立たない。
  sync(
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

  // 実行の窓に入ったことを通知する。
  private notifyApproach(node: KinematicState): void {
    if (this.approachNotified === node) return;
    this.approachNotified = node;
    this._notifier.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
  }

  // 操作対象の軌道が目標軌道に十分近づいていれば達成を通知する。ノードと操作対象で最も強く引く
  // 天体が違えば、要素同士の比較自体が意味を持たないので判定しない。
  private notifyAchieved(
    node: KinematicState, controlled: Controllable,
    celestialBodies: readonly CelestialBody[], pivot: number,
  ): void {
    if (this.achievedNotified === node) return;
    const plan = controlled.plan;
    const controlledCenter = strongestAttractor(
      controlled.motion.state.r, celestialBodies, pivot,
    );
    const nodeCenter = strongestAttractor(node.r, celestialBodies, pivot);
    if (controlledCenter.id !== nodeCenter.id) return;
    const targetEl = orbitalElementsOf(node, nodeCenter, pivot);
    const controlledEl = controlled.motion.orbitalElementsAround(controlledCenter, pivot);
    if (!controlledEl || !targetEl || !orbitalElementsClose(controlledEl, targetEl)) return;
    this.achievedNotified = node;
    // 計画軌道へ到達したノードは、その場で実行済みとして削除する。同時刻のノードが複数あれば
    // まとめて落ちるので、残り件数は落とした後の実数を読む。
    plan.consumeNodesUpTo(node.t, controlled.motion.state);
    const remain = plan.nodes.length;
    if (remain === 0) {
      this._notifier.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
    } else {
      this._notifier.hint(`✓ ノード達成 — 残り ${remain} 件`, 4000);
    }
    this._uiSfx.warp();
  }
}

// 2 軌道の近さ判定(長半径・離心率・軌道面)
function orbitalElementsClose(a: OrbitalElements, b: OrbitalElements): boolean {
  if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
  const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
  return (
    Math.abs(a.a - b.a) / b.a < NODE_TOL_SMA &&
    Math.abs(a.e - b.e) < NODE_TOL_ECC &&
    (Math.acos(planeCos) * 180) / Math.PI < NODE_TOL_PLANE_DEG
  );
}
