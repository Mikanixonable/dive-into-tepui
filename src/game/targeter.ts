import * as THREE from 'three/webgpu';
import { add, addScaled, cross, dot, lenSq, norm, scale, sub, v3, Vec3 } from '../physics/vec3';
import { OrbitLine } from '../render/orbitline';
import * as C from './const';
import { Enemy } from './game-entity/enemy';
import type { EntityManager } from './simulation/entity-manager';
import { Player } from './player/player';
import { Hud } from './hud/hud';
import { Sfx } from '../audio/sfx';
import { Input, PointerPoint } from './input/input';
import { CameraSystem, ProjectFn } from './camera/camera-system';
import { MarkerManager } from './marker/marker-manager';
import { FloatingOrigin } from './floating-origin';

export class Targeter {
  private lockedTarget: Enemy | null = null;
  autoTarget: Enemy | null = null;

  // ターゲット標的面(自機の方を向いた仮想の的)の通過点(ターゲット相対オフセットで
  // 保持し、的に貼り付いて見せる)。markBoardCrossings が push し、updateBoardMarkers
  // が寿命管理と描画を行う。
  boardMarks: { off: Vec3; age: number; }[] = [];

  // ターゲット軌道のハイライト線(オレンジ)。自機軌道とほぼ重なるケースが多い
  // (近傍ランデブー狙いのため)。埋もれて見えなくならないよう強い不透明度にし、
  // renderOrder を自機軌道より上げて透明オブジェクトの描画順に依存せず必ず上に描く。
  readonly orbitLine = new OrbitLine(0xff6a00, 0.9);

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(private readonly _hud: Hud, _sfx: Sfx, private readonly markerManager: MarkerManager, scene: THREE.Scene) {
    this.orbitLine.line.renderOrder = 2;
    scene.add(this.orbitLine.line);
  }

  // 生存判定込みの現在ターゲット。autoTarget は死亡個体を指したまま残ることがあるため、
  // 描画・軌道線更新など「生きているターゲットだけを見たい」箇所はこちらを使う。
  get aliveTarget(): Enemy | null {
    return this.autoTarget && this.autoTarget.alive ? this.autoTarget : null;
  }

  // 右クリックによるターゲットロックとオートターゲット選定を行い、現在のターゲットを返す。
  updateCombatTargeting(
    player: Player,
    enemies: Enemy[],
    input: Input,
    cameraSystem: CameraSystem,
  ): Enemy | null {
    this.handleTargetLockByRightClick(input, enemies, player, cameraSystem.activeCameraProjection);
    this.autoTarget = this.resolveAutoTarget(enemies, player, cameraSystem.activeCamera);
    return this.autoTarget;
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  markBoardCrossings(player: Player, entities: EntityManager): void {
    const target = this.aliveTarget;
    if (!target) return;
    const n = norm(sub(target.state.r, player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    // 各弾について、前フレームと今フレームの位置が的面をどちら向きに跨いだかを見る。
    for (const b of entities.bullets) {
      if (b.type !== 'normal' || !b.alive) continue; // 的通過マーカーは通常弾のみ対象
      const prevR = b.prevState.r;
      const d0 = dot(sub(prevR, target.state.r), n);
      const d1 = dot(sub(b.state.r, target.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(prevR, sub(b.state.r, prevR), t);
      const off = sub(pos, target.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > C.MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // ターゲットに紐づく表示物(軌道線・的通過マーク・方位マーカー・相対 AN/DN)をまとめて
  // 更新する。ターゲットの選定を持つのがここなので、その表示もここに閉じる。
  sync(dt: number, fo: FloatingOrigin, player: Player, enemies: Enemy[], overviewMode: boolean, project: ProjectFn): void {
    this.syncOrbitLine(fo, enemies, overviewMode);
    this.syncBoardMarkers(dt, project);
    this.syncTargetDirMarkers(player, overviewMode, project);
    this.syncNodeMarkers(player, project);
  }

  // ハイライト線を最新のターゲット状態に合わせる。
  private syncOrbitLine(fo: FloatingOrigin, enemies: Enemy[], overviewMode: boolean): void {
    const tgt = this.aliveTarget;
    for (const enemy of enemies) {
      const showGray = overviewMode && enemy.alive && enemy !== tgt;
      enemy.orbitLine.sync(showGray ? enemy.elements : null, fo);
    }

    const tgtEl = tgt ? tgt.elements : null;
    this.orbitLine.sync(tgtEl, fo);
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  private syncBoardMarkers(dt: number, project: ProjectFn): void {
    // 記録側の markBoardCrossings と同じ aliveTarget を見る: autoTarget のままだと
    // 撃破後も死亡個体の凍結位置を基準に ✦ を描き続けてしまう。
    const target = this.aliveTarget;
    if (!target) this.boardMarks.length = 0;
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
    });
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !target) {
        this.markerManager.hide(key);
        continue;
      }
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
      this.markerManager.setPosition(key, 'mk-boardhit', '✦', add(target.state.r, m.off), project, '', 0.25 + 0.75 * fade);
    }
  }

  // ターゲット/その反対方向を指す方向マーカー(戦闘ビューのみ)。自機の軌道基準方向マーカー
  // (player-markers.ts)と同じ扱いで、自機位置を原点に置く。
  private syncTargetDirMarkers(player: Player, overviewMode: boolean, project: ProjectFn): void {
    const tgt = this.aliveTarget;
    if (overviewMode || !tgt) {
      this.markerManager.hide('tgtdir');
      this.markerManager.hide('atgdir');
      return;
    }
    const tgtDir = norm(sub(tgt.state.r, player.state.r));
    this.markerManager.setDirection('tgtdir', 'mk-tgtdir', '◇', player.state.r, tgtDir, project);
    this.markerManager.setDirection('atgdir', 'mk-tgtdir', '◆', player.state.r, scale(tgtDir, -1), project);
  }

  // ターゲットの軌道面との交線(相対昇交点・降交点)を自機の軌道上に表示する。
  // 面変更(ノーマル/アンチノーマル)burn を行うべき位置がひと目で分かる。
  private syncNodeMarkers(player: Player, project: ProjectFn): void {
    const playerEl = player.elements;
    const tgtEl = this.aliveTarget?.elements ?? null;

    const lineDir = playerEl && tgtEl ? cross(playerEl.hHat, tgtEl.hHat) : null;
    // lenSq が極小 = 軌道面がほぼ一致 → 交線が定まらない
    if (!playerEl || !lineDir || lenSq(lineDir) < 1e-6) {
      this.markerManager.hide('an');
      this.markerManager.hide('dn');
      return;
    }

    const d = norm(lineDir);
    const thAsc = Math.atan2(dot(d, playerEl.qHat), dot(d, playerEl.pHat));
    const rAsc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc));
    const rDesc = playerEl.p / (1 + playerEl.e * Math.cos(thAsc + Math.PI));

    this.markerManager.setPosition('an', 'mk-node', '▲', scale(d, rAsc), project, 'AN');
    this.markerManager.setPosition('dn', 'mk-node', '▽', scale(d, -rDesc), project, 'DN');
  }

  // 戦闘ビューの右クリックは射撃と兼用なので、敵に当たったかどうかに関わらずここで消費する
  // (マップ編集中はこの経路自体が呼ばれず、右クリックはノード/フォーカスへ回る)。
  private handleTargetLockByRightClick(input: Input, enemies: Enemy[], player: Player, project: ProjectFn): void {
    if (!player.alive) return;
    input.takeRightClicks((click) => {
      this.pickTargetAt(click, enemies, project);
      return true;
    });
  }

  // クリック位置の許容半径内で画面上最も近い敵をロック対象に切り替える。
  // 命中がなければ既存のロックを解除する。
  private pickTargetAt(click: PointerPoint, enemies: Enemy[], project: ProjectFn): void {
    let hit: Enemy | null = null;
    let minDistSq = C.TARGET_LOCK_PICK_PX_SQ;
    // 画面座標に射影し、クリック位置との距離が最小の生存敵を探す。
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const p = project(enemy.state.r);
      if (!p.front) continue;
      const dx = p.x - click.x;
      const dy = p.y - click.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < minDistSq) {
        minDistSq = distSq;
        hit = enemy;
      }
    }
    if (hit) {
      this.toggleLockedTarget(hit);
      return;
    }
    if (this.lockedTarget !== null) {
      this.lockedTarget = null;
      this._hud.hint('ターゲット固定解除');
    }
  }

  // 指定した敵をロック対象にする。既にロック中の敵と同じならロックを解除する。
  private toggleLockedTarget(hit: Enemy): void {
    if (this.lockedTarget === hit) {
      this.lockedTarget = null;
      this._hud.hint('ターゲット固定解除');
      return;
    }
    this.lockedTarget = hit;
    this._hud.hint(`ターゲット固定: ${hit.name}`);
  }

  // ロック中の生存敵があればそれを返す。なければカメラ正面方向に最も近い生存敵を返す。
  private resolveAutoTarget(enemies: Enemy[], player: Player, activeCamera: THREE.PerspectiveCamera): Enemy | null {
    if (this.lockedTarget && this.lockedTarget.alive) {
      return this.lockedTarget;
    }
    this.lockedTarget = null;
    let bestTarget: Enemy | null = null;
    let bestDot = -1;
    const camFwdW = new THREE.Vector3();
    activeCamera.getWorldDirection(camFwdW);
    const camFwdVec = v3(camFwdW.x, camFwdW.y, camFwdW.z);
    // カメラ前方ベクトルとの内積が最大の敵(=画面中心に最も近い敵)を選ぶ。
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const dir = norm(sub(enemy.state.r, player.state.r));
      const d = dot(camFwdVec, dir);
      if (d > bestDot) {
        bestDot = d;
        bestTarget = enemy;
      }
    }
    return bestTarget;
  }
}
