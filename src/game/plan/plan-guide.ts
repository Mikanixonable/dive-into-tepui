// 直近ノードの実行ガイド: 実行時刻を過ぎたノードの消化、接近・達成の通知、NODE/BURN マーカー。
import { KinematicState } from '../../physics/kinematic-state';
import { OrbitalElements } from '../../physics/elements';
import { strongestAttractor } from '../../physics/attractor';
import { CelestialMotion } from '../../physics/celestial-motion';
import { orbitalElementsOf } from '../../physics/elements';
import { addScaled, dot, len, norm, sub } from '../../math/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { fmtDist, fmtSpeed, fmtTime } from '../hud/utils';
import { UiSfx } from '../../audio/sfx/ui-sfx';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';
import { DIRECTION_GLYPH, ORBIT_POINT_GLYPH } from '../marker/marker-glyphs';
import type { Player } from '../player/player';
import type { PlanPath } from './plan-path';

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

  constructor(
    private readonly _hud: Hud,
    private readonly _uiSfx: UiSfx,
    private readonly markerManager: MarkerManager,
  ) {
  }

  // 実行時刻を過ぎたノードを計画から落とし、直近ノードへの接近と計画軌道の達成を
  // ノードごとに一度だけ通知する。player がいなければ何もしない。
  update(player: Player | null, simTime: number, editMode: boolean, celestialBodies: readonly CelestialMotion[]): void {
    if (!player || editMode) return;
    const plan = player.plan;
    plan.consumeNodesUpTo(simTime - NODE_EXPIRE_GRACE, player.state);

    const node = plan.firstNode();
    // 実行の窓に入るまでは通知しない。窓の手前では自機はまだ噴射前の軌道にいるので、
    // 目標軌道との近さを見ても達成の判定にならない。
    if (node && simTime >= node.t - C.NODE_APPROACH_LEAD) {
      this.notifyApproach(node);
      this.notifyAchieved(node, player, celestialBodies, simTime);
    }
  }

  // 直近ノードの NODE・BURN マーカーを同期する。位置と方向は path の表示変換を通す —
  // 同じ計画を描いた折れ線とマーカーが同じ座標系に載っていなければ、線の上に立たない。
  sync(
    player: Player | null, simTime: number, editMode: boolean, project: ProjectFn, path: PlanPath,
  ): void {
    const node = editMode || !player ? undefined : player.plan.firstNode();
    if (!player || !node) {
      this.markerManager.hide('nd');
      this.markerManager.hide('burn');
      this.markerManager.hide('burn-bearing');
      return;
    }

    // NODE マーカー: ノードまでの残り時間を表示する。
    const tRem = node.t - simTime;
    const tLabel = tRem >= 0 ? `T-${fmtTime(tRem)}` : `T+${fmtTime(-tRem)}`;
    const queued = player.plan.nodes.length;
    const more = queued > 1 ? ` (+${queued - 1})` : '';

    // BURN マーカー: 目標速度との差分ベクトルを噴射方向として表示する。
    const dvRem = sub(node.v, player.state.v);
    const mag = len(dvRem);
    const nodeDist = len(sub(node.r, player.state.r));
    const maxAccel = C.THROTTLE_LEVELS[C.THROTTLE_LEVELS.length - 1] ?? 1;
    const burnTime = maxAccel > 0 ? mag / maxAccel : 0;
    const shipPos = path.toDisplay(player.state.r, simTime);
    const burnDir = path.toDisplayDir(dvRem, simTime);
    this.markerManager.setPosition(
      'nd', 'mk-mnode', ORBIT_POINT_GLYPH.maneuverNode, path.toDisplay(node.r, node.t), project,
      `NODE${more}\nBURN ${fmtTime(burnTime)}\nDIST ${fmtDist(nodeDist)}\nTIME ${tLabel}`,
    );
    this.markerManager.setDirection(
      'burn',
      'mk-burn',
      ORBIT_POINT_GLYPH.burnPoint,
      shipPos,
      burnDir,
      project,
      `BURN ${mag.toFixed(1)} m/s → ${fmtSpeed(len(node.v))}`,
    );
    // 噴射方向が視界外(背面を含む)なら、敵・弾薬と同じ画面端の方位ガイドを出す。
    const burnPoint = project(addScaled(shipPos, norm(burnDir), C.MARKER_DIR_DIST));
    this.markerManager.setBearing('burn-bearing', 'mk-dir', DIRECTION_GLYPH.bearing, burnPoint, '', 0.7, C.COLOR_MARKER_NODE);
  }

  // 実行の窓に入ったことを通知する。
  private notifyApproach(node: KinematicState): void {
    if (this.approachNotified === node) return;
    this.approachNotified = node;
    this._hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
  }

  // 自機の軌道が目標軌道に十分近づいていれば達成を通知する。ノードと自機で最も強く引く
  // 天体が違えば、要素同士の比較自体が意味を持たないので判定しない。
  private notifyAchieved(
    node: KinematicState, player: Player,
    celestialBodies: readonly CelestialMotion[], pivot: number,
  ): void {
    if (this.achievedNotified === node) return;
    const plan = player.plan;
    const playerCenter = strongestAttractor(player.state.r, celestialBodies, pivot);
    const nodeCenter = strongestAttractor(node.r, celestialBodies, pivot);
    if (playerCenter.id !== nodeCenter.id) return;
    const targetEl = orbitalElementsOf(node, nodeCenter, pivot);
    const playerEl = player.orbitalElementsAround(playerCenter, pivot);
    if (!playerEl || !targetEl || !orbitalElementsClose(playerEl, targetEl)) return;
    this.achievedNotified = node;
    // 計画軌道へ到達したノードは、その場で実行済みとして削除する。同時刻のノードが複数あれば
    // まとめて落ちるので、残り件数は落とした後の実数を読む。
    plan.consumeNodesUpTo(node.t, player.state);
    const remain = plan.nodes.length;
    if (remain === 0) {
      this._hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
    } else {
      this._hud.hint(`✓ ノード達成 — 残り ${remain} 件`, 4000);
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
