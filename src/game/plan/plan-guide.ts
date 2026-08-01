// 直近ノードの実行ガイド: 実行時刻を過ぎたノードの消化、接近・達成の通知、NODE/BURN マーカー。
import { Elements, OrbitState, elementsFromState } from '../../physics/orbital';
import { dot, len, sub } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { fmtSpeed } from '../hud/utils';
import { Sfx } from '../../audio/sfx';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';
import { Plan } from './plan';
import type { Player } from '../player/player';

export class PlanGuide {
  // 通知済みのノード。ノードは編集のたびに別インスタンスへ置き換わるので、同一性の比較が
  // そのまま「同じノードについて既に通知したか」の判定になる。
  private approachNotified: OrbitState | null = null;
  private achievedNotified: OrbitState | null = null;

  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly markerManager: MarkerManager,
  ) {
  }

  // 実行時刻を過ぎたノードを計画から落とし、直近ノードへの接近と計画軌道の達成を
  // ノードごとに一度だけ通知する。
  update(plan: Plan, player: Player, simTime: number, editMode: boolean): void {
    if (editMode || !player.alive) return;
    plan.dropNodesBefore(simTime - C.NODE_EXPIRE_GRACE);

    const node = plan.firstNode();
    // 実行の窓に入るまでは通知しない。窓の手前では自機はまだ噴射前の軌道にいるので、
    // 目標軌道との近さを見ても達成の判定にならない。
    if (!node || simTime < node.t - C.NODE_APPROACH_LEAD) return;
    this.notifyApproach(node);
    this.notifyAchieved(plan, node, player);
  }

  // 直近ノードの ◆NODE・⬢BURN マーカーを同期する。
  sync(plan: Plan, player: Player, simTime: number, editMode: boolean, project: ProjectFn): void {
    const node = editMode || !player.alive ? undefined : plan.firstNode();
    if (!node) {
      this.markerManager.hide('nd');
      this.markerManager.hide('burn');
      return;
    }

    // NODE マーカー: ノードまでの残り時間を表示する。
    const tRem = node.t - simTime;
    const tLabel =
      tRem >= 0
        ? `T-${Math.floor(tRem / 60)}:${String(Math.floor(tRem % 60)).padStart(2, '0')}`
        : `T+${Math.floor(-tRem / 60)}:${String(Math.floor(-tRem % 60)).padStart(2, '0')}`;
    const more = plan.nodes.length > 1 ? ` (+${plan.nodes.length - 1})` : '';
    this.markerManager.setPosition('nd', 'mk-mnode', '◆', node.r, project, `NODE ${tLabel}${more}`);

    // BURN マーカー: 目標速度との差分ベクトルを噴射方向として表示する。
    const dvRem = sub(node.v, player.state.v);
    const mag = len(dvRem);
    this.markerManager.setDirection(
      'burn',
      'mk-burn',
      '⬢',
      player.state.r,
      dvRem,
      project,
      `BURN ${mag.toFixed(1)} m/s → ${fmtSpeed(len(node.v))}`,
    );
  }

  // 実行の窓に入ったことを通知する。
  private notifyApproach(node: OrbitState): void {
    if (this.approachNotified === node) return;
    this.approachNotified = node;
    this._hud.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000);
  }

  // 自機の軌道が目標軌道に十分近づいていれば達成を通知する。
  private notifyAchieved(plan: Plan, node: OrbitState, player: Player): void {
    if (this.achievedNotified === node) return;
    const targetEl = elementsFromState(node.r, node.v);
    const playerEl = player.elements;
    if (!playerEl || !targetEl || !orbitClose(playerEl, targetEl)) return;
    this.achievedNotified = node;
    // 達成しても node は実行時刻を過ぎるまで計画に残るので、残件数からは自身を除く。
    const remain = plan.nodes.length - 1;
    if (remain === 0) {
      this._hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
    } else {
      this._hud.hint(`✓ ノード達成 — 残り ${remain} 件`, 4000);
    }
    this._sfx.warp();
  }
}

// 2 軌道の近さ判定(長半径・離心率・軌道面)
function orbitClose(a: Elements, b: Elements): boolean {
  if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
  const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
  return (
    Math.abs(a.a - b.a) / b.a < C.NODE_TOL_SMA &&
    Math.abs(a.e - b.e) < C.NODE_TOL_ECC &&
    (Math.acos(planeCos) * 180) / Math.PI < C.NODE_TOL_PLANE_DEG
  );
}
