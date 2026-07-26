// 発砲中に開く PIP(照準ズーム窓)の中へ重ねるマーカー: 窓中心のクロスヘアと、
// ターゲット枠・見越し点。全画面のマーカーとは投影も座標系も違う(PipCamera.projection は
// rect 内のピクセル座標を返す)ため、同じ対象でも別キーのマーカーとして持ち、矩形から
// はみ出した分は描かない。PipRenderer が所有し、描画パスではなく sync フェーズで動く。
import * as C from '../const';
import { leadPoint } from '../../physics/intercept';
import { Projected } from '../../physics/projection';
import { PipCamera, PipRect } from '../camera/pip-camera';
import { MarkerManager } from './marker-manager';
import type { Enemy } from '../orbit-entity/enemy';
import type { Player } from '../player/player';

export class PipOverlay {
  constructor(private readonly markerManager: MarkerManager) { }

  // active: このフレームに PIP を描くか(判定の正本は game が持ち、描画パスと同じ値が来る)。
  sync(active: boolean, player: Player, target: Enemy | null, pipCamera: PipCamera): void {
    this.syncCrosshair(active, pipCamera.rect);
    this.syncTargetMarkers(active, player, target, pipCamera);
  }

  // 窓の中心 = 機首方向(PipCamera は機首固定)。実在の対象を指すマーカーではないので
  // 投影は経由せず、矩形の中心へ直接置く。
  private syncCrosshair(active: boolean, rect: PipRect): void {
    if (!active) {
      this.markerManager.hide('pip-crosshair');
      return;
    }
    this.markerManager.set(
      'pip-crosshair', 'mk-pip-crosshair', '+',
      rect.x + rect.w / 2, rect.y + rect.h / 2, true,
    );
  }

  private syncTargetMarkers(active: boolean, player: Player, target: Enemy | null, pipCamera: PipCamera): void {
    if (!active || !player.alive || !target || !target.alive) {
      this.markerManager.hide('pip-tgt');
      this.markerManager.hide('pip-lead');
      return;
    }
    const { rect, projection } = pipCamera;
    const inRect = (p: Projected): boolean =>
      p.front && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

    // ラベル無し(''): resolveCollisions の押し退け対象から自然に除外される
    const tp = projection(target.state.r);
    this.markerManager.set('pip-tgt', 'mk-target', '◇', tp.x, tp.y, inRect(tp), '');

    const lead = leadPoint(target.state, player.state, C.MUZZLE_SPEED, C.LEAD_MAX_TIME);
    if (lead === null) {
      this.markerManager.hide('pip-lead');
      return;
    }
    const lp = projection(lead);
    this.markerManager.set('pip-lead', 'mk-lead', '✛', lp.x, lp.y, inRect(lp), '', 1, target.accentColor);
  }
}
