// HUD マーカー(スクリーン投影)の同期。方向マーカー・敵/リード/AMMO マーカー・
// ノード(AN/DN)・ズーム PIP オーバーレイを担う。
// game.ts を import しない — 依存は MarkerCtx 引数・コンストラクタ注入(MarkerManager)のみ。
// スクリーン投影(project)はアクティブカメラ依存のため game.ts 側の関数を呼び出し
// 引数として受け取る(planner.ts の project 注入パターンに合わせる)。
import { qRotate } from '../../physics/attitude';
import { Vec3, add, addScaled, cross, dot, lenSq, norm, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Ammo, OrbitEntity } from '../orbit-entity/entities';
import { Enemy } from '../orbit-entity/enemy';
import { MarkerManager } from './marker-manager';
import { fmtMarkerDist } from '../hud/utils';
import { Player } from '../player/player';
import { solveLeadTime } from '../../physics/intercept';
import { FloatingOrigin } from '../floating-origin';
import { ProjectFn } from '../camera/camera-system';
import { PipRect } from '../camera/pip-camera';

// updateMarkers が必要とする、Game 側の現在状態のスナップショット(内部で個々の
// フィールドへ分解して各 private メソッドへ渡す)。
// player / enemies / target / ammos は参照渡し(state.r 等を読むだけで
// ミューテートしない)。
export interface MarkerCtx {
  mapMode: boolean;
  player: Player;
  enemies: Enemy[];
  target: Enemy | null;
  ammos: Ammo[];
  mapLabelIds: string[]; // マップモードのラベル(MapCamera.labels の id 一覧、非マップ時に隠す)
  simTime: number;
}

// todo: 雑多クラスになっている。
export class MarkerForGame {
  constructor(private readonly markerManager: MarkerManager) {}

  // 方向マーカー(プログレード/レトログレード/ノーマル/アンチノーマル/動径 in-out)・
  // 機首ボアサイト・敵/ターゲット/AMMO マーカー・視界外方位/リードマーカーを更新する。
  updateMarkers(ctx: MarkerCtx, fo: FloatingOrigin, project: ProjectFn): void {
    const { mapMode, player, enemies, target, ammos, mapLabelIds } = ctx;

    // マップ/戦闘ビューの出し分け(方向マーカーは戦闘ビューのみ・自機マーカーはマップのみ)
    this.updateMapModeMarkers(mapMode, mapLabelIds, player, fo, project);

    // 軌道基準方向 (Navball の代わり)。角運動量は自機の物理位置から求める。
    if (!mapMode) this.updateOrbitalDirectionMarkers(target, player, fo, project);

    // 機首方向(ボアサイト)
    this.updateBoresightMarker(player, mapMode, fo, project);

    // 敵マーカー
    this.updateEnemyMarkers(enemies, target, fo, project);

    // 補給のマーカー
    this.updateAmmoMarkers(ammos, fo, project);

    // リード(見越し)マーカーと、視界外敵機の方位マーカー
    this.updateLeadAndDirMarkers(ctx, player, fo, project);

    // 以前の単一リードマーカーのクリーンアップ
    this.markerManager.hide('lead');

    // 重なったマーカーテキストを押し退けて線で繋ぐ
    this.markerManager.resolveCollisions();
  }

  private updateMapModeMarkers(mapMode: boolean, mapLabelIds: string[], player: Player, fo: FloatingOrigin, project: ProjectFn): void {
    if (mapMode) {
      this.markerManager.hide('pro');
      this.markerManager.hide('retro');
      this.markerManager.hide('nrm');
      this.markerManager.hide('anm');
      this.markerManager.hide('radout');
      this.markerManager.hide('radin');
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
      this.markerManager.hide('bore');
      this.markerManager.hide('lead');
      // 自機位置マーカー(自機の描画フレーム位置を投影)
      const sp = project(fo.RtoThreeV3(player.state.r));
      this.markerManager.set('self', 'mk-self', '▷', sp.x, sp.y, sp.front, 'PLAYER');
    } else {
      this.markerManager.hide('self');
      for (const id of mapLabelIds) {
        this.markerManager.hide(id);
      }
    }
  }

  // pr = 自機の ECI 位置(物理量)。方向マーカーは自機の軌道基準フレームを表すので、
  // 自機の位置を足してから投影すべき
  private updateOrbitalDirectionMarkers(target: Enemy | null, player: Player, fo: FloatingOrigin, project: ProjectFn): void {
    const pr = player.state.r;
    const pv = player.state.v;
    const proDir = norm(pv);
    const nrmDir = norm(cross(pr, pv));
    const radDir = cross(proDir, nrmDir);
    const DIST = 5e4; // 遠方に投影して方向を示す

    const pro = project(fo.RtoThreeV3(add(pr, scale(proDir, DIST))));
    this.markerManager.set('pro', 'mk-pro', '⊙', pro.x, pro.y, pro.front, 'PROGRADE [Q]');
    const ret = project(fo.RtoThreeV3(add(pr, scale(proDir, -DIST))));
    this.markerManager.set('retro', 'mk-retro', '⊗', ret.x, ret.y, ret.front, 'RETROGRADE [E]');

    const nrm = project(fo.RtoThreeV3(add(pr, scale(nrmDir, DIST))));
    this.markerManager.set('nrm', 'mk-nrm', '▲', nrm.x, nrm.y, nrm.front, 'NORMAL [A]');
    const anm = project(fo.RtoThreeV3(add(pr, scale(nrmDir, -DIST))));
    this.markerManager.set('anm', 'mk-nrm', '▽', anm.x, anm.y, anm.front, 'ANTINORMAL [D]');

    const radOut = project(fo.RtoThreeV3(add(pr, scale(radDir, DIST))));
    this.markerManager.set('radout', 'mk-rad', '◎', radOut.x, radOut.y, radOut.front, 'RADIAL OUT [W]');
    const radIn = project(fo.RtoThreeV3(add(pr, scale(radDir, -DIST))));
    this.markerManager.set('radin', 'mk-rad', '◉', radIn.x, radIn.y, radIn.front, 'RADIAL IN [S]');

    if (target) {
      const tgtDir = norm(sub(target.state.r, pr));
      const tmk = project(fo.RtoThreeV3(add(pr, scale(tgtDir, DIST))));
      this.markerManager.set('tgtdir', 'mk-tgtdir', '◇', tmk.x, tmk.y, tmk.front, '');
      const atmk = project(fo.RtoThreeV3(add(pr, scale(tgtDir, -DIST))));
      this.markerManager.set('atgdir', 'mk-tgtdir', '◆', atmk.x, atmk.y, atmk.front, '');
    } else {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
    }
  }

  private updateBoresightMarker(player: Player, mapMode: boolean, fo: FloatingOrigin, project: ProjectFn): void {
    if (player.alive && !mapMode) {
      const fwd = qRotate(player.att.q, v3(0, 0, 1));
      const bs = project(fo.RtoThreeV3(add(player.state.r, scale(fwd, 5e4))));
      this.markerManager.set('bore', 'mk-boresight', '┼', bs.x, bs.y, bs.front);
    } else {
      this.markerManager.hide('bore');
    }
  }

  // 画面上で近接する敵マーカーをクラスタ化し、代表(ターゲット優先→最近距離)だけに
  // まとめラベルを付ける。
  private updateEnemyMarkers(enemies: Enemy[], target: Enemy | null, fo: FloatingOrigin, project: ProjectFn): void {
    const CLUSTER_RADIUS = 40;
    const enemyMarkers: { i: number, e: Enemy, p: {x:number, y:number, front:boolean}, dist: number, isTgt: boolean, groupHide: boolean, groupCount: number }[] = [];

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      const key = `e${i}`;
      if (!e.alive) {
        this.markerManager.hide(key);
        continue;
      }
      const rel = fo.RtoThreeV3(e.state.r);
      const p = project(rel);
      const dist = rel.length();
      const isTgt = e === target;
      enemyMarkers.push({ i, e, p, dist, isTgt, groupHide: false, groupCount: 1 });
    }

    const groups: (typeof enemyMarkers)[] = [];
    for (const m of enemyMarkers) {
      if (!m.p.front) continue;
      let added = false;
      for (const g of groups) {
        const head = g[0]!;
        const dx = head.p.x - m.p.x;
        const dy = head.p.y - m.p.y;
        if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_RADIUS) {
          g.push(m);
          added = true;
          break;
        }
      }
      if (!added) {
        groups.push([m]);
      }
    }

    for (const g of groups) {
      if (g.length <= 1) continue;
      g.sort((a, b) => {
        if (a.isTgt !== b.isTgt) return a.isTgt ? -1 : 1;
        return a.dist - b.dist;
      });
      const rep = g[0]!;
      rep.groupCount = g.length;
      for (let j = 1; j < g.length; j++) {
        g[j]!.groupHide = true;
      }
    }

    for (const m of enemyMarkers) {
      const key = `e${m.i}`;
      let text = '';
      if (!m.groupHide) {
        if (m.groupCount > 1) {
          text = `${m.e.name} x${m.groupCount} ${fmtMarkerDist(m.dist)}`;
        } else {
          text = `${m.e.name} ${fmtMarkerDist(m.dist)}`;
        }
      }
      this.markerManager.set(key, m.isTgt ? 'mk-target' : 'mk-enemy', '◇', m.p.x, m.p.y, m.p.front, text);
    }
  }

  private updateAmmoMarkers(ammos: Ammo[], fo: FloatingOrigin, project: ProjectFn): void {
    for (let i = 0; i < C.MAX_AMMO; i++) {
      const key = `mg${i}`;
      const ammo = ammos[i];
      if (!ammo || !ammo.alive) {
        this.markerManager.hide(key);
        continue;
      }
      const rel = fo.RtoThreeV3(ammo.state.r);
      const p = project(rel);
      const dist = rel.length();
      this.markerManager.set(key, 'mk-ammo', '▣', p.x, p.y, p.front, `AMMO ${fmtMarkerDist(dist)}`);
    }
  }

  private updateLeadAndDirMarkers(ctx: MarkerCtx, player: Player, fo: FloatingOrigin, project: ProjectFn): void {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    if (!ctx.mapMode && player.alive) {
      for (const enemy of ctx.enemies) {
        if (!enemy.alive) {
          this.markerManager.hide('lead-' + enemy.name);
          this.markerManager.hide('dir-' + enemy.name);
          continue;
        }

        // Target tracking for LEAD (keep showing for ~20s)
        if (enemy === ctx.target) {
          enemy.lastTargetedSim = ctx.simTime;
        }

        const relP = sub(enemy.state.r, player.state.r);
        const relV = sub(enemy.state.v, player.state.v);
        const p = project(fo.RtoThreeV3(enemy.state.r));

        const hexColor = enemy.accent ? '#' + enemy.accent.toString(16).padStart(6, '0') : '#ff6a00';

        // 方位マーカー (視界外)
        this.updateOffscreenDirMarker(enemy, p, cx, cy, hexColor);

        // LEAD マーカー (20秒履歴)
        this.updateLeadMarker(ctx.simTime, enemy, relP, relV, hexColor, fo, project);
      }
    } else {
      for (const ship of ctx.enemies) {
        this.markerManager.hide('lead-' + ship.name);
        this.markerManager.hide('dir-' + ship.name);
      }
    }
  }

  private updateOffscreenDirMarker(
    enemy: Enemy,
    p: { x: number; y: number; front: boolean },
    cx: number,
    cy: number,
    hexColor: string,
  ): void {
    const offscreen = !p.front || p.x < 0 || p.x > window.innerWidth || p.y < 0 || p.y > window.innerHeight;
    if (offscreen) {
      let dx = p.x - cx;
      let dy = p.y - cy;
      if (!p.front) {
        dx = -dx;
        dy = -dy;
      }
      const ang = Math.atan2(dy, dx);
      const r = Math.min(cx, cy) * 0.8;
      const mx = cx + r * Math.cos(ang);
      const my = cy + r * Math.sin(ang);

      const rotDeg = ang * 180 / Math.PI + 90; // '▲' faces UP initially, so add 90 deg
      this.markerManager.set('dir-' + enemy.name, 'mk-dir', '▲', mx, my, true, '', 0.6, hexColor, rotDeg);
    } else {
      this.markerManager.hide('dir-' + enemy.name);
    }
  }

  private updateLeadMarker(
    simTime: number,
    enemy: Enemy,
    relP: Vec3,
    relV: Vec3,
    hexColor: string,
    fo: FloatingOrigin,
    project: ProjectFn,
  ): void {
    let showLead = false;
    if (enemy.lastTargetedSim !== undefined && (simTime - enemy.lastTargetedSim < 20)) {
      showLead = true;
    }

    if (showLead) {
      const t = solveLeadTime(relP, relV, C.MUZZLE_SPEED);
      if (t !== null && t < 25) {
        const lead = addScaled(relP, relV, t);
        const lp = project(fo.RtoThreeV3(lead));
        this.markerManager.set('lead-' + enemy.name, 'mk-lead', '✛', lp.x, lp.y, lp.front, '', 1, hexColor);
      } else {
        this.markerManager.hide('lead-' + enemy.name);
      }
    } else {
      this.markerManager.hide('lead-' + enemy.name);
    }
  }

  // ターゲットの軌道面との交線(相対昇交点・降交点)を自機の軌道上に表示する。
  // 面変更(ノーマル/アンチノーマル)burn を行うべき位置がひと目で分かる。
  updateNodeMarkers(fo: FloatingOrigin, player: Player, tgt: OrbitEntity | null, project: ProjectFn): void {
    const playerEl = player.elements;
    const tgtEl = tgt?.elements ?? null;

    if (!playerEl || !tgtEl) {
      this.markerManager.hide('an');
      this.markerManager.hide('dn');
      return;
    }
    const lineDir = cross(playerEl.hHat, tgtEl.hHat);
    if (lenSq(lineDir) < 1e-6) {
      // 軌道面がほぼ一致 → 交線が定まらない
      this.markerManager.hide('an');
      this.markerManager.hide('dn');
      return;
    }

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));

    const ascP = project(fo.RtoThreeV3(scale(d, rAsc)));
    const descP = project(fo.RtoThreeV3(scale(d, -rDesc)));
    this.markerManager.set('an', 'mk-node', '▲', ascP.x, ascP.y, ascP.front, 'AN');
    this.markerManager.set('dn', 'mk-node', '▽', descP.x, descP.y, descP.front, 'DN');
  }

  // ズームウィンドウ(PIP)のオーバーレイ: ターゲット菱形枠と LEAD マーカーを PIP の
  // 矩形内に描く。project は PipCamera.projection(rect 内のピクセル座標へ写像済み)を
  // 渡す。PIP を描画しないフレームでは rect=null で呼び、両マーカーを隠す。
  updatePipOverlay(
    target: Enemy | null,
    player: Player,
    fo: FloatingOrigin,
    project: ProjectFn,
    rect: PipRect | null,
  ): void {
    if (!rect || !target || !target.alive || !player.alive) {
      this.markerManager.hide('pip-tgt');
      this.markerManager.hide('pip-lead');
      return;
    }
    const inRect = (p: { x: number; y: number; front: boolean }): boolean =>
      p.front && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

    const relP = sub(target.state.r, player.state.r);
    const relV = sub(target.state.v, player.state.v);
    const p = project(fo.RtoThreeV3(target.state.r));
    const t = solveLeadTime(relP, relV, C.MUZZLE_SPEED);

    // ラベル無し(''): resolveCollisions の押し退け対象から自然に除外される
    this.markerManager.set('pip-tgt', 'mk-target', '◇', p.x, p.y, inRect(p), '');

    const hexColor = target.accent ? '#' + target.accent.toString(16).padStart(6, '0') : '#ff6a00';
    if (t !== null && t < 25) {
      const lead = addScaled(target.state.r, relV, t);
      const lp = project(fo.RtoThreeV3(lead));
      this.markerManager.set('pip-lead', 'mk-lead', '✛', lp.x, lp.y, inRect(lp), '', 1, hexColor);
    } else {
      this.markerManager.hide('pip-lead');
    }
  }

}
