// 直近ノードの噴射ガイド表示・達成判定・ノード消化。
import { Elements, elementsFromState } from '../../physics/orbital';
import { dot, len, sub } from '../../physics/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { fmtSpeed } from '../hud/utils';
import { Sfx } from '../../audio/sfx';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from '../marker/marker-manager';
import { Plan } from './plan';
import type { Player } from '../player/player';
import { SimSpeedManager } from '../sim-speed-manager';
export class PlanGuide {
  constructor(
    private readonly _hud: Hud,
    private readonly _sfx: Sfx,
    private readonly markerManager: MarkerManager,
  ) {
  }

  update(
    plan: Plan,
    player: Player,
    simTime: number,
    simSpeedManager: SimSpeedManager,
    editMode: boolean,
    project: ProjectFn,
  ) {
    if (editMode) {
      this.markerManager.hide('burn');
      return;
    }

    const node = plan.firstNode();
    if (!node || !player.alive) {
      this.markerManager.hide('nd');
      this.markerManager.hide('burn');
      return;
    }

    const targetEl = elementsFromState(node.r, node.v);
    const playerEl = player.elements;

    if (playerEl && targetEl && this.orbitClose(playerEl, targetEl)) {
      plan.consumeFirstNode();
      simSpeedManager.cancelAutoWarp();
      this.markerManager.hide('nd');
      this.markerManager.hide('burn');
      if (plan.nodes.length === 0) {
        this._hud.hint('✓ マニューバ達成 — 計画軌道に到達', 5000);
      } else {
        this._hud.hint(`✓ ノード達成 — 残り ${plan.nodes.length} 件`, 4000);
      }
      this._sfx.warp();
      return;
    }

    const tRem = node.t - simTime;
    const tLabel =
      tRem >= 0
        ? `T-${Math.floor(tRem / 60)}:${String(Math.floor(tRem % 60)).padStart(2, '0')}`
        : `T+${Math.floor(-tRem / 60)}:${String(Math.floor(-tRem % 60)).padStart(2, '0')}`;
    const more = plan.nodes.length > 1 ? ` (+${plan.nodes.length - 1})` : '';
    this.markerManager.setPosition('nd', 'mk-mnode', '◆', node.r, project, `NODE ${tLabel}${more}`);

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

  // 2 軌道の近さ判定(長半径・離心率・軌道面)
  private orbitClose(a: Elements, b: Elements): boolean {
    if (!isFinite(a.a) || !isFinite(b.a) || a.a <= 0 || b.a <= 0) return false;
    const planeCos = Math.max(-1, Math.min(1, dot(a.hHat, b.hHat)));
    return (
      Math.abs(a.a - b.a) / b.a < C.NODE_TOL_SMA &&
      Math.abs(a.e - b.e) < C.NODE_TOL_ECC &&
      (Math.acos(planeCos) * 180) / Math.PI < C.NODE_TOL_PLANE_DEG
    );
  }
}
