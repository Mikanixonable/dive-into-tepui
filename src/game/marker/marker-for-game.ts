// HUD マーカー(スクリーン投影)の同期。方向マーカー・敵/リード/AMMO マーカー・
// ノード(AN/DN)・ズーム PIP オーバーレイを担う。
// game.ts を import しない — 依存は MarkerCtx 引数・コンストラクタ注入(MarkerManager)のみ。
// スクリーン投影(project)はアクティブカメラ依存のため game.ts 側の関数を呼び出し
// 引数として受け取る(planner.ts の project 注入パターンに合わせる)。
import * as THREE from 'three/webgpu';
import { qRotate } from '../../physics/attitude';
import { Vec3, addScaled, cross, dot, len, lenSq, norm, scale, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Ammo, OrbitEntity } from '../orbit-entity/entities';
import { Enemy } from '../orbit-entity/enemy';
import { MarkerManager } from './marker-manager';
import { fmtMarkerDist } from '../../hud/utils';
import { Player } from '../player/player';
import { solveLeadTime } from '../../physics/intercept';

export type ProjectFn = (rel: Vec3) => { x: number; y: number; front: boolean };

const tmpV2 = new THREE.Vector3();

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
  activeCamera: THREE.PerspectiveCamera; // PIP オーバーレイ専用の投影に使う
  simTime: number;
}

export class MarkerForGame {
  constructor(private readonly markerManager: MarkerManager) {}

  // 方向マーカー(プログレード/レトログレード/ノーマル/アンチノーマル/動径 in-out)・
  // 機首ボアサイト・敵/ターゲット/AMMO マーカー・視界外方位/リードマーカーを更新する。
  updateMarkers(ctx: MarkerCtx, pv: Vec3, project: ProjectFn): void {
    const { mapMode, player, enemies, target, ammos, mapLabelIds } = ctx;
    const o = player.state.r;

    // マップ/戦闘ビューの出し分け(方向マーカーは戦闘ビューのみ・自機マーカーはマップのみ)
    this.updateMapModeMarkers(mapMode, mapLabelIds, project);

    // 軌道基準方向 (Navball の代わり)
    if (!mapMode) this.updateOrbitalDirectionMarkers(target, o, pv, project);

    // 機首方向(ボアサイト)
    this.updateBoresightMarker(player, mapMode, project);

    // 敵マーカー
    this.updateEnemyMarkers(enemies, target, o, project);

    // 補給のマーカー
    this.updateAmmoMarkers(ammos, o, project);

    // リード(見越し)マーカーと、視界外敵機の方位マーカー
    this.updateLeadAndDirMarkers(ctx, o, pv, project);

    // 以前の単一リードマーカーのクリーンアップ
    this.markerManager.hide('lead');

    // 重なったマーカーテキストを押し退けて線で繋ぐ
    this.markerManager.resolveCollisions();
  }

  private updateMapModeMarkers(mapMode: boolean, mapLabelIds: string[], project: ProjectFn): void {
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
      // 自機位置マーカー
      const sp = project(v3());
      this.markerManager.set('self', 'mk-self', '▷', sp.x, sp.y, sp.front, 'PLAYER');
    } else {
      this.markerManager.hide('self');
      for (const id of mapLabelIds) {
        this.markerManager.hide(id);
      }
    }
  }

  private updateOrbitalDirectionMarkers(target: Enemy | null, o: Vec3, pv: Vec3, project: ProjectFn): void {
    const proDir = norm(pv);
    const nrmDir = norm(cross(o, pv));
    const radDir = cross(proDir, nrmDir);
    const DIST = 5e4; // 遠方に投影して方向を示す

    const pro = project(scale(proDir, DIST));
    this.markerManager.set('pro', 'mk-pro', '⊙', pro.x, pro.y, pro.front, 'PROGRADE [Q]');
    const ret = project(scale(proDir, -DIST));
    this.markerManager.set('retro', 'mk-retro', '⊗', ret.x, ret.y, ret.front, 'RETROGRADE [E]');

    const nrm = project(scale(nrmDir, DIST));
    this.markerManager.set('nrm', 'mk-nrm', '▲', nrm.x, nrm.y, nrm.front, 'NORMAL [A]');
    const anm = project(scale(nrmDir, -DIST));
    this.markerManager.set('anm', 'mk-nrm', '▽', anm.x, anm.y, anm.front, 'ANTINORMAL [D]');

    const radOut = project(scale(radDir, DIST));
    this.markerManager.set('radout', 'mk-rad', '◎', radOut.x, radOut.y, radOut.front, 'RADIAL OUT [W]');
    const radIn = project(scale(radDir, -DIST));
    this.markerManager.set('radin', 'mk-rad', '◉', radIn.x, radIn.y, radIn.front, 'RADIAL IN [S]');

    if (target) {
      const tgtDir = norm(sub(target.state.r, o));
      const tmk = project(scale(tgtDir, DIST));
      this.markerManager.set('tgtdir', 'mk-tgtdir', '◇', tmk.x, tmk.y, tmk.front, '');
      const atmk = project(scale(tgtDir, -DIST));
      this.markerManager.set('atgdir', 'mk-tgtdir', '◆', atmk.x, atmk.y, atmk.front, '');
    } else {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
    }
  }

  private updateBoresightMarker(player: Player, mapMode: boolean, project: ProjectFn): void {
    if (player.alive && !mapMode) {
      const fwd = qRotate(player.att.q, v3(0, 0, 1));
      const bs = project(scale(fwd, 5e4));
      this.markerManager.set('bore', 'mk-boresight', '┼', bs.x, bs.y, bs.front);
    } else {
      this.markerManager.hide('bore');
    }
  }

  // 画面上で近接する敵マーカーをクラスタ化し、代表(ターゲット優先→最近距離)だけに
  // まとめラベルを付ける。
  private updateEnemyMarkers(enemies: Enemy[], target: Enemy | null, o: Vec3, project: ProjectFn): void {
    const CLUSTER_RADIUS = 40;
    const enemyMarkers: { i: number, e: Enemy, p: {x:number, y:number, front:boolean}, dist: number, isTgt: boolean, groupHide: boolean, groupCount: number }[] = [];

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      const key = `e${i}`;
      if (!e.alive) {
        this.markerManager.hide(key);
        continue;
      }
      const rel = sub(e.state.r, o);
      const p = project(rel);
      const dist = len(rel);
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

  private updateAmmoMarkers(ammos: Ammo[], o: Vec3, project: ProjectFn): void {
    for (let i = 0; i < C.MAX_AMMO; i++) {
      const key = `mg${i}`;
      const ammo = ammos[i];
      if (!ammo || !ammo.alive) {
        this.markerManager.hide(key);
        continue;
      }
      const rel = sub(ammo.state.r, o);
      const p = project(rel);
      const dist = len(rel);
      this.markerManager.set(key, 'mk-ammo', '▣', p.x, p.y, p.front, `AMMO ${fmtMarkerDist(dist)}`);
    }
  }

  private updateLeadAndDirMarkers(ctx: MarkerCtx, o: Vec3, pv: Vec3, project: ProjectFn): void {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    if (!ctx.mapMode && ctx.player.alive) {
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

        const relP = sub(enemy.state.r, o);
        const p = project(relP);
        const hexColor = enemy.accent ? '#' + enemy.accent.toString(16).padStart(6, '0') : '#ff6a00';

        // 方位マーカー (視界外)
        this.updateOffscreenDirMarker(enemy, p, cx, cy, hexColor);

        // LEAD マーカー (20秒履歴)
        this.updateLeadMarker(ctx.simTime, enemy, relP, pv, hexColor, project);
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
    pv: Vec3,
    hexColor: string,
    project: ProjectFn,
  ): void {
    let showLead = false;
    if (enemy.lastTargetedSim !== undefined && (simTime - enemy.lastTargetedSim < 20)) {
      showLead = true;
    }

    if (showLead) {
      const relV = sub(enemy.state.v, pv);
      const t = solveLeadTime(relP, relV, C.MUZZLE_SPEED);
      if (t !== null && t < 25) {
        const lead = addScaled(relP, relV, t);
        const lp = project(lead);
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
  updateNodeMarkers(player: Player, tgt: OrbitEntity | null, project: ProjectFn): void {
    const playerEl = player.elements;
    const tgtEl = tgt?.elements ?? null;
    
    if (!playerEl || !tgtEl) {
      this.markerManager.hide('an');
      this.markerManager.hide('dn');
      return;
    }
    const o = player.state.r;
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

    const ascP = project(sub(scale(d, rAsc), o));
    const descP = project(sub(scale(d, -rDesc), o));
    this.markerManager.set('an', 'mk-node', '▲', ascP.x, ascP.y, ascP.front, 'AN');
    this.markerManager.set('dn', 'mk-node', '▽', descP.x, descP.y, descP.front, 'DN');
  }

  // ズームウィンドウ(PIP)のオーバーレイ: ターゲット菱形枠と LEAD マーカーを PIP の
  // 矩形内に描く。main.ts が PIP 用に activeCamera を一時的にポーズして render() した
  // 直後、カメラを元の位置・姿勢へ復元する前に rect を渡して呼ぶ。PIP を描画しない
  // フレームでは rect=null で呼び、両マーカーを隠す。
  // (この段階でカメラは PIP 用の position/quaternion/fov/aspect に設定済みで、
  //  renderer.render() 済みなので matrixWorldInverse/projectionMatrix は最新のはず。
  //  念のため updateMatrixWorld() を呼んでから使う。)
  updatePipOverlay(
    target: Enemy | null,
    player: Player,
    activeCamera: THREE.PerspectiveCamera,
    rect: { x: number; y: number; w: number; h: number } | null,
  ): void {
    if (!rect || !target || !target.alive || !player.alive) {
      this.markerManager.hide('pip-tgt');
      this.markerManager.hide('pip-lead');
      return;
    }
    const cam = activeCamera;
    cam.updateMatrixWorld();
    const o = player.state.r;
    const pv = player.state.v;

    const projectPip = (rel: Vec3): { x: number; y: number; front: boolean } => {
      tmpV2.set(rel.x, rel.y, rel.z).applyMatrix4(cam.matrixWorldInverse);
      const front = tmpV2.z < 0;
      tmpV2.applyMatrix4(cam.projectionMatrix);
      return {
        x: rect.x + (tmpV2.x * 0.5 + 0.5) * rect.w,
        y: rect.y + (-tmpV2.y * 0.5 + 0.5) * rect.h,
        front,
      };
    };
    const inRect = (p: { x: number; y: number; front: boolean }): boolean =>
      p.front && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

    const relP = sub(target.state.r, o);
    const p = projectPip(relP);
    // ラベル無し(''): resolveCollisions の押し退け対象から自然に除外される
    this.markerManager.set('pip-tgt', 'mk-target', '◇', p.x, p.y, inRect(p), '');

    const hexColor = target.accent ? '#' + target.accent.toString(16).padStart(6, '0') : '#ff6a00';
    const relV = sub(target.state.v, pv);
    const t = solveLeadTime(relP, relV, C.MUZZLE_SPEED);
    if (t !== null && t < 25) {
      const lead = addScaled(relP, relV, t);
      const lp = projectPip(lead);
      this.markerManager.set('pip-lead', 'mk-lead', '✛', lp.x, lp.y, inRect(lp), '', 1, hexColor);
    } else {
      this.markerManager.hide('pip-lead');
    }
  }

}
