// HUD マーカー(スクリーン投影)・ステータスパネルの同期。方向マーカー・敵/リード/
// AMMO マーカー・ターゲット面通過点(ボードマーク)・ノード(AN/DN)・ズーム PIP
// オーバーレイ・ステータスパネル(setStats/setTarget/setEnemyList)を担う。
// game.ts を import しない — 依存は MarkersCtx 引数・コンストラクタ注入(Hud)のみ。
// スクリーン投影(project)はアクティブカメラ依存のため game.ts 側の関数を呼び出し
// 引数として受け取る(planner.ts の project 注入パターンに合わせる)。
import * as THREE from 'three/webgpu';
import { Elements } from '../physics/orbital';
import { qRotate } from '../physics/attitude';
import { Vec3, add, addScaled, cross, dot, len, lenSq, norm, scale, sub, v3 } from '../physics/vec3';
import * as C from './const';
import { MagPickup, Ship } from './entities';
import { Hud } from './hud';
import { TouchControls } from './touch';

export type ProjectFn = (rel: Vec3) => { x: number; y: number; front: boolean };

// スクリーン投影マーカーのラベル用コンパクトな距離表記(例: "420m" / "2.2km")
function fmtMarkerDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m.toFixed(0)}m`;
}

const tmpV2 = new THREE.Vector3();

// updateMarkers / updateNodeMarkers / updateBoardMarkers / updatePipOverlay /
// updateHudPanels が必要とする、Game 側の現在状態のスナップショット。
// player / enemies / target / magPickups は参照渡し(state.r 等を読むだけで
// ミューテートしない)。boardMarks は MarkersSystem 自身が保持する(combat.ts の
// checkBoardCrossings が直接この配列へ push する)。
export interface MarkersCtx {
  mapMode: boolean;
  player: Ship;
  enemies: Ship[];
  target: Ship | null;
  magPickups: MagPickup[];
  mapLabelIds: string[]; // マップモードのラベル(mapView.labels の id 一覧、非マップ時に隠す)
  activeCamera: THREE.PerspectiveCamera; // PIP オーバーレイ専用の投影に使う
  touchControls: TouchControls | null;
  simTime: number;
  solveLeadTime: (relP: Vec3, relV: Vec3, s: number) => number | null;

  // --- ステータスパネル(updateHudPanels) ---
  warp: number;
  paused: boolean;
  rcsDamp: boolean;
  throttleIdx: number;
  fineAttitude: boolean;
  progradeHold: boolean;
  camFollowAttitude: boolean;
  roundsInMag: number;
  magsLeft: number;
  reloadTimer: number;
  alt: number;
  altDescending: boolean;
  qdyn: number;
  hullTemp: number;
  shots: number;
  kills: number;
  totalEnemies: number;
  stage: number;
  stage00WaveCount: number;
  stage0TimeLeft: number;
}

export class MarkersSystem {
  // ターゲット標的面の通過点(ターゲット相対オフセットで保持し、的に貼り付いて見せる)
  boardMarks: { off: Vec3; age: number }[] = [];
  private hudTimer = 0;
  private listTimer = 0;

  constructor(private readonly hud: Hud) {}

  // 方向マーカー(プログレード/レトログレード/ノーマル/アンチノーマル/動径 in-out)・
  // 機首ボアサイト・敵/ターゲット/AMMO マーカー・視界外方位/リードマーカーを更新する。
  updateMarkers(ctx: MarkersCtx, pv: Vec3, project: ProjectFn): void {
    const o = ctx.player.state.r;
    const tgt = ctx.target;

    // 方向マーカーは戦闘ビューのみ(マップでは意味を持たない)
    if (ctx.mapMode) {
      this.hud.hideMarker('pro');
      this.hud.hideMarker('retro');
      this.hud.hideMarker('nrm');
      this.hud.hideMarker('anm');
      this.hud.hideMarker('radout');
      this.hud.hideMarker('radin');
      this.hud.hideMarker('tgtdir');
      this.hud.hideMarker('atgdir');
      this.hud.hideMarker('bore');
      this.hud.hideMarker('lead');
      // 自機位置マーカー
      const sp = project(v3());
      this.hud.marker('self', 'mk-self', '▷', sp.x, sp.y, sp.front, 'PLAYER');
    } else {
      this.hud.hideMarker('self');
      for (const id of ctx.mapLabelIds) {
        this.hud.hideMarker(id);
      }
    }

    if (!ctx.mapMode) {
      // 軌道基準方向 (Navball の代わり)
      const proDir = norm(pv);
      const nrmDir = norm(cross(o, pv));
      const radDir = cross(proDir, nrmDir);
      const DIST = 5e4; // 遠方に投影して方向を示す

      const pro = project(scale(proDir, DIST));
      this.hud.marker('pro', 'mk-pro', '⊙', pro.x, pro.y, pro.front, 'PROGRADE [Q]');
      const ret = project(scale(proDir, -DIST));
      this.hud.marker('retro', 'mk-retro', '⊗', ret.x, ret.y, ret.front, 'RETROGRADE [E]');

      const nrm = project(scale(nrmDir, DIST));
      this.hud.marker('nrm', 'mk-nrm', '▲', nrm.x, nrm.y, nrm.front, 'NORMAL [A]');
      const anm = project(scale(nrmDir, -DIST));
      this.hud.marker('anm', 'mk-nrm', '▽', anm.x, anm.y, anm.front, 'ANTINORMAL [D]');

      const radOut = project(scale(radDir, DIST));
      this.hud.marker('radout', 'mk-rad', '◎', radOut.x, radOut.y, radOut.front, 'RADIAL OUT [W]');
      const radIn = project(scale(radDir, -DIST));
      this.hud.marker('radin', 'mk-rad', '◉', radIn.x, radIn.y, radIn.front, 'RADIAL IN [S]');

      if (tgt) {
        const tgtDir = norm(sub(tgt.state.r, o));
        const tmk = project(scale(tgtDir, DIST));
        this.hud.marker('tgtdir', 'mk-tgtdir', '◇', tmk.x, tmk.y, tmk.front, '');
        const atmk = project(scale(tgtDir, -DIST));
        this.hud.marker('atgdir', 'mk-tgtdir', '◆', atmk.x, atmk.y, atmk.front, '');
      } else {
        this.hud.hideMarker('tgtdir');
        this.hud.hideMarker('atgdir');
      }
    }

    // 機首方向(ボアサイト)
    if (ctx.player.alive && !ctx.mapMode) {
      const fwd = qRotate(ctx.player.att.q, v3(0, 0, 1));
      const bs = project(scale(fwd, 5e4));
      this.hud.marker('bore', 'mk-boresight', '┼', bs.x, bs.y, bs.front);
    } else {
      this.hud.hideMarker('bore');
    }

    // 敵マーカー
    const CLUSTER_RADIUS = 40;
    const enemyMarkers: { i: number, e: Ship, p: {x:number, y:number, front:boolean}, dist: number, isTgt: boolean, groupHide: boolean, groupCount: number }[] = [];

    for (let i = 0; i < ctx.enemies.length; i++) {
      const e = ctx.enemies[i]!;
      const key = `e${i}`;
      if (!e.alive) {
        this.hud.hideMarker(key);
        continue;
      }
      const rel = sub(e.state.r, o);
      const p = project(rel);
      const dist = len(rel);
      const isTgt = e === tgt;
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
      this.hud.marker(key, m.isTgt ? 'mk-target' : 'mk-enemy', '◇', m.p.x, m.p.y, m.p.front, text);
    }

    // 補給マガジンのマーカー
    for (let i = 0; i < C.MAX_MAG_PICKUPS; i++) {
      const key = `mg${i}`;
      const mp = ctx.magPickups[i];
      if (!mp || !mp.alive) {
        this.hud.hideMarker(key);
        continue;
      }
      const rel = sub(mp.state.r, o);
      const p = project(rel);
      const dist = len(rel);
      this.hud.marker(key, 'mk-ammo', '▣', p.x, p.y, p.front, `AMMO ${fmtMarkerDist(dist)}`);
    }

    // リード(見越し)マーカーと、視界外敵機の方位マーカー
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;

    if (!ctx.mapMode && ctx.player.alive) {
      for (const ship of ctx.enemies) {
        if (!ship.alive) {
          this.hud.hideMarker('lead-' + ship.name);
          this.hud.hideMarker('dir-' + ship.name);
          continue;
        }

        // Target tracking for LEAD (keep showing for ~20s)
        if (ship === tgt) {
          ship.lastTargetedSim = ctx.simTime;
        }

        const relP = sub(ship.state.r, o);
        const p = project(relP);
        const hexColor = ship.accent ? '#' + ship.accent.toString(16).padStart(6, '0') : '#ff6a00';

        // 方位マーカー (視界外)
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
          this.hud.marker('dir-' + ship.name, 'mk-dir', '▲', mx, my, true, '', 0.6, hexColor, rotDeg);
        } else {
          this.hud.hideMarker('dir-' + ship.name);
        }

        // LEAD マーカー (20秒履歴)
        let showLead = false;
        if (ship.lastTargetedSim !== undefined && (ctx.simTime - ship.lastTargetedSim < 20)) {
          showLead = true;
        }

        if (showLead) {
          const relV = sub(ship.state.v, pv);
          const t = ctx.solveLeadTime(relP, relV, C.MUZZLE_SPEED);
          if (t !== null && t < 25) {
            const lead = addScaled(relP, relV, t);
            const lp = project(lead);
            this.hud.marker('lead-' + ship.name, 'mk-lead', '✛', lp.x, lp.y, lp.front, '', 1, hexColor);
          } else {
            this.hud.hideMarker('lead-' + ship.name);
          }
        } else {
          this.hud.hideMarker('lead-' + ship.name);
        }
      }
    } else {
      for (const ship of ctx.enemies) {
        this.hud.hideMarker('lead-' + ship.name);
        this.hud.hideMarker('dir-' + ship.name);
      }
    }

    // 以前の単一リードマーカーのクリーンアップ
    this.hud.hideMarker('lead');

    // 重なったマーカーテキストを押し退けて線で繋ぐ
    this.hud.resolveMarkerCollisions();
  }

  // ターゲットの軌道面との交線(相対昇交点・降交点)を自機の軌道上に表示する。
  // 面変更(ノーマル/アンチノーマル)burn を行うべき位置がひと目で分かる。
  updateNodeMarkers(ctx: MarkersCtx, playerEl: Elements | null, tgtEl: Elements | null, project: ProjectFn): void {
    if (!playerEl || !tgtEl) {
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }
    const o = ctx.player.state.r;
    const lineDir = cross(playerEl.hHat, tgtEl.hHat);
    if (lenSq(lineDir) < 1e-6) {
      // 軌道面がほぼ一致 → 交線が定まらない
      this.hud.hideMarker('an');
      this.hud.hideMarker('dn');
      return;
    }

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));

    const ascP = project(sub(scale(d, rAsc), o));
    const descP = project(sub(scale(d, -rDesc), o));
    this.hud.marker('an', 'mk-node', '▲', ascP.x, ascP.y, ascP.front, 'AN');
    this.hud.marker('dn', 'mk-node', '▽', descP.x, descP.y, descP.front, 'DN');
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  updateBoardMarkers(ctx: MarkersCtx, dt: number, project: ProjectFn): void {
    const tgt = ctx.target;
    const o = ctx.player.state.r;
    if (!tgt) this.boardMarks.length = 0;
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
    });
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !tgt) {
        this.hud.hideMarker(key);
        continue;
      }
      const p = project(sub(add(tgt.state.r, m.off), o));
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
      this.hud.marker(key, 'mk-boardhit', '✦', p.x, p.y, p.front, '', 0.25 + 0.75 * fade);
    }
  }

  // ズームウィンドウ(PIP)のオーバーレイ: ターゲット菱形枠と LEAD マーカーを PIP の
  // 矩形内に描く。main.ts が PIP 用に activeCamera を一時的にポーズして render() した
  // 直後、カメラを元の位置・姿勢へ復元する前に rect を渡して呼ぶ。PIP を描画しない
  // フレームでは rect=null で呼び、両マーカーを隠す。
  // (この段階でカメラは PIP 用の position/quaternion/fov/aspect に設定済みで、
  //  renderer.render() 済みなので matrixWorldInverse/projectionMatrix は最新のはず。
  //  念のため updateMatrixWorld() を呼んでから使う。)
  updatePipOverlay(ctx: MarkersCtx, rect: { x: number; y: number; w: number; h: number } | null): void {
    const tgt = ctx.target;
    if (!rect || !tgt || !tgt.alive || !ctx.player.alive) {
      this.hud.hideMarker('pip-tgt');
      this.hud.hideMarker('pip-lead');
      return;
    }
    const cam = ctx.activeCamera;
    cam.updateMatrixWorld();
    const o = ctx.player.state.r;
    const pv = ctx.player.state.v;

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

    const relP = sub(tgt.state.r, o);
    const p = projectPip(relP);
    // ラベル無し(''): resolveMarkerCollisions の押し退け対象から自然に除外される
    this.hud.marker('pip-tgt', 'mk-target', '◇', p.x, p.y, inRect(p), '');

    const hexColor = tgt.accent ? '#' + tgt.accent.toString(16).padStart(6, '0') : '#ff6a00';
    const relV = sub(tgt.state.v, pv);
    const t = ctx.solveLeadTime(relP, relV, C.MUZZLE_SPEED);
    if (t !== null && t < 25) {
      const lead = addScaled(relP, relV, t);
      const lp = projectPip(lead);
      this.hud.marker('pip-lead', 'mk-lead', '✛', lp.x, lp.y, inRect(lp), '', 1, hexColor);
    } else {
      this.hud.hideMarker('pip-lead');
    }
  }

  // ステータスパネル(HUD 上部のスタッツ・ターゲット情報・敵一覧)を一定周期で更新する。
  updateHudPanels(
    ctx: MarkersCtx,
    dt: number,
    playerEl: Elements | null,
    tgtEl: Elements | null,
  ): void {
    const tgt = ctx.target;
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      // タッチUIのトグルボタン(制動・微動・ホールド)の点灯状態を実際のモードに同期する。
      // progradeHold は手動回転で自動解除されることもあるため、専用のトグル時だけでなく
      // ここで毎回反映しておく。
      ctx.touchControls?.setActive('KeyT', ctx.rcsDamp);
      ctx.touchControls?.setActive('KeyV', ctx.fineAttitude);
      ctx.touchControls?.setActive('KeyC', ctx.progradeHold);
      this.hud.setStats({
        met: ctx.simTime,
        warpLabel: `×${ctx.warp}`,
        paused: ctx.paused,
        rcsDamp: ctx.rcsDamp,
        throttleIdx: ctx.throttleIdx,
        fineAttitude: ctx.fineAttitude,
        progradeHold: ctx.progradeHold,
        camFollowAttitude: ctx.camFollowAttitude,
        roundsInMag: ctx.roundsInMag,
        magsLeft: ctx.magsLeft,
        reloadTimer: ctx.reloadTimer,
        alt: ctx.alt,
        altDescending: ctx.altDescending,
        spd: len(ctx.player.state.v),
        apAlt: playerEl ? playerEl.apAlt : NaN,
        peAlt: playerEl ? playerEl.peAlt : NaN,
        incDeg: playerEl ? playerEl.incDeg : NaN,
        period: playerEl ? playerEl.period : NaN,
        qdyn: ctx.qdyn,
        hullTemp: ctx.hullTemp,
        shots: ctx.shots,
        kills: ctx.kills,
        total: ctx.totalEnemies,
        stage0State:
          ctx.stage === -1 || ctx.stage === 0
            ? {
              hp: ctx.player.hp,
              maxHp: C.PLAYER_MAX_HP,
              msg:
                ctx.stage === -1
                  ? `サバイバル 第${ctx.stage00WaveCount}波`
                  : `残り時間: ${Math.ceil(ctx.stage0TimeLeft)}秒`,
            }
            : null,
      });

      if (tgt) {
        const relP = sub(tgt.state.r, ctx.player.state.r);
        const relV = sub(tgt.state.v, ctx.player.state.v);
        const dist = len(relP);
        const relIncDeg =
          playerEl && tgtEl
            ? (Math.acos(Math.max(-1, Math.min(1, dot(playerEl.hHat, tgtEl.hHat)))) * 180) / Math.PI
            : NaN;
        this.hud.setTarget({
          name: tgt.name,
          dist,
          closing: dist > 1e-6 ? -dot(relP, relV) / dist : 0,
          relSpeed: len(relV),
          hp: tgt.hp,
          maxHp: tgt.maxHp,
          apAlt: tgtEl ? tgtEl.apAlt : NaN,
          peAlt: tgtEl ? tgtEl.peAlt : NaN,
          incDeg: tgtEl ? tgtEl.incDeg : NaN,
          period: tgtEl ? tgtEl.period : NaN,
          relIncDeg,
        });
      } else {
        this.hud.setTarget(null);
      }
    }

    this.listTimer -= dt;
    if (this.listTimer <= 0) {
      this.listTimer = 0.25;
      const rows = ctx.enemies
        .filter((e) => e.alive)
        .map((e) => ({
          name: e.name,
          dist: len(sub(e.state.r, ctx.player.state.r)),
          targeted: e === tgt,
        }))
        .sort((a, b) => a.dist - b.dist);
      this.hud.setEnemyList(rows);
    }
  }
}
