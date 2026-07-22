import * as THREE from 'three/webgpu';
import { add, addScaled, dot, lenSq, norm, sub, v3, Vec3 } from '../physics/vec3';
import { Elements, elementsFromState } from '../physics/orbital';
import { OrbitLine } from '../render/orbitline';
import * as C from './const';
import { Enemy } from './orbit-entity/enemy';
import type { Simulator } from './orbit-entity/simulator';
import { Player } from './player/player';
import { Hud } from '../hud/hud';
import { Sfx } from '../audio/sfx';
import { Input } from './input';
import { ProjectFn } from './camera/camera-system';

export class Targeter {
  private lockedTarget: Enemy | null = null;
  autoTarget: Enemy | null = null;

  // ターゲット標的面(自機の方を向いた仮想の的)の通過点(ターゲット相対オフセットで
  // 保持し、的に貼り付いて見せる)。markBoardCrossings が push し、updateBoardMarkers
  // が寿命管理と描画を行う。
  boardMarks: { off: Vec3; age: number }[] = [];

  // ターゲット軌道のハイライト線(オレンジ)。自機軌道とほぼ重なるケースが多い
  // (近傍ランデブー狙いのため)。埋もれて見えなくならないよう強い不透明度にし、
  // renderOrder を自機軌道より上げて透明オブジェクトの描画順に依存せず必ず上に描く。
  readonly orbitLine = new OrbitLine(0xff6a00, 0.9);

  // sfx は現状未使用だが、hud/sfx は必ず対で注入する方針のため受け取る(フィールドとしては保持しない)。
  constructor(private readonly _hud: Hud, _sfx: Sfx, scene: THREE.Scene) {
    this.orbitLine.line.renderOrder = 2;
    scene.add(this.orbitLine.line);
  }

  // 生存判定込みの現在ターゲット。autoTarget は死亡個体を指したまま残ることがあるため、
  // 描画・軌道線更新など「生きているターゲットだけを見たい」箇所はこちらを使う。
  get aliveTarget(): Enemy | null {
    return this.autoTarget && this.autoTarget.alive ? this.autoTarget : null;
  }

  updateCombatTargeting(
    player: Player,
    enemies: Enemy[],
    input: Input,
    activeCamera: THREE.PerspectiveCamera,
    project: ProjectFn,
  ): Enemy | null {
    this.handleTargetLockByRightClick(input, enemies, player, project);
    this.autoTarget = this.resolveAutoTarget(enemies, player, activeCamera);
    return this.autoTarget;
  }

  // ハイライト線を最新のターゲット状態に合わせ、HUD が必要とする Elements を返す。
  updateOrbitLine(origin: Vec3): Elements | null {
    const tgt = this.aliveTarget;
    const tgtEl = tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null;
    this.orbitLine.update(tgtEl, origin);
    return tgtEl;
  }

  // ターゲット位置に「自機の方を向いた的(標的面)」があると見なし、
  // 発射弾がその面を自機側から通過した点をターゲット相対で記録する。
  // 次弾の照準修正の目安になるマーカーとして一定時間表示する。
  markBoardCrossings(player: Player, simulator: Simulator): void {
    const target = this.aliveTarget;
    if (!target) return;
    const n = norm(sub(target.state.r, player.state.r)); // 的の法線 = 視線方向
    if (lenSq(n) < 0.5) return;

    for (const b of simulator.bullets) {
      if (b.type !== 'normal' || !b.alive) continue; // 的通過マーカーは通常弾のみ対象
      const d0 = dot(sub(b.prevR, target.state.r), n);
      const d1 = dot(sub(b.state.r, target.state.r), n);
      if (!(d0 < 0 && d1 >= 0)) continue; // 自機側 → 向こう側への通過のみ
      const t = d0 / (d0 - d1);
      const pos = addScaled(b.prevR, sub(b.state.r, b.prevR), t);
      const off = sub(pos, target.state.r);
      if (lenSq(off) > C.BOARD_RADIUS * C.BOARD_RADIUS) continue; // 的から外れすぎ
      this.boardMarks.push({ off, age: 0 });
      if (this.boardMarks.length > C.MAX_BOARD_MARKS) this.boardMarks.shift();
    }
  }

  // ターゲット標的面を通過した自弾の位置を、的に貼り付いた光点として表示する
  updateBoardMarkers(player: Player, dt: number, project: ProjectFn): void {
    const target = this.autoTarget;
    const o = player.state.r;
    if (!target) this.boardMarks.length = 0;
    this.boardMarks = this.boardMarks.filter((m) => {
      m.age += dt;
      return m.age < C.BOARD_MARK_LIFETIME;
    });
    for (let i = 0; i < C.MAX_BOARD_MARKS; i++) {
      const key = `bh${i}`;
      const m = this.boardMarks[i];
      if (!m || !target) {
        this._hud.markerManager.hide(key);
        continue;
      }
      const p = project(sub(add(target.state.r, m.off), o));
      const fade = 1 - m.age / C.BOARD_MARK_LIFETIME;
      this._hud.markerManager.set(key, 'mk-boardhit', '✦', p.x, p.y, p.front, '', 0.25 + 0.75 * fade);
    }
  }

  private handleTargetLockByRightClick(input: Input, enemies: Enemy[], player: Player, project: ProjectFn): void {
    const rightClicks = input.rightClicks();
    if (rightClicks.length <= 0 || !player.alive) return;
    const click = rightClicks[rightClicks.length - 1]!;
    let hit: Enemy | null = null;
    let minDistSq = C.TARGET_LOCK_PICK_PX_SQ;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const p = project(sub(enemy.state.r, player.state.r));
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

  private toggleLockedTarget(hit: Enemy): void {
    if (this.lockedTarget === hit) {
      this.lockedTarget = null;
      this._hud.hint('ターゲット固定解除');
      return;
    }
    this.lockedTarget = hit;
    this._hud.hint(`ターゲット固定: ${hit.name}`);
  }

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
