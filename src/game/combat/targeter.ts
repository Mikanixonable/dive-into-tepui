import * as THREE from 'three/webgpu';
import { dot, norm, sub, v3, Vec3 } from '../../physics/vec3';
import { Elements, elementsFromState } from '../../physics/orbital';
import { OrbitLine } from '../../render/orbitline';
import * as C from '../const';
import { Enemy } from '../enemy/enemy';
import { Player } from '../player/player';
import { Hud } from '../../hud/hud';
import { Sfx } from '../../audio/sfx';
import { Input } from '../input';
import { ProjectFn } from '../camera/projection';

export interface TargeterCtx {
  player: Player;
  enemies: Enemy[];
  input: Input;
  activeCamera: THREE.PerspectiveCamera;
  project: ProjectFn;
}

export class Targeter {
  private lockedTarget: Enemy | null = null;
  autoTarget: Enemy | null = null;

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

  updateCombatTargeting(ctx: TargeterCtx): Enemy | null {
    ctx.input.takeClicks();
    this.handleTargetLockByRightClick(ctx);
    this.autoTarget = this.resolveAutoTarget(ctx);
    return this.autoTarget;
  }

  // ハイライト線を最新のターゲット状態に合わせ、HUD が必要とする Elements を返す。
  updateOrbitLine(origin: Vec3): Elements | null {
    const tgt = this.aliveTarget;
    const tgtEl = tgt ? elementsFromState(tgt.state.r, tgt.state.v) : null;
    this.orbitLine.update(tgtEl, origin);
    return tgtEl;
  }

  private handleTargetLockByRightClick(ctx: TargeterCtx): void {
    const rightClicks = ctx.input.takeRightClicks();
    if (rightClicks.length <= 0 || !ctx.player.alive) return;
    const click = rightClicks[rightClicks.length - 1]!;
    let hit: Enemy | null = null;
    let minDistSq = C.TARGET_LOCK_PICK_PX_SQ;
    for (const enemy of ctx.enemies) {
      if (!enemy.alive) continue;
      const p = ctx.project(sub(enemy.state.r, ctx.player.state.r));
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

  private resolveAutoTarget(ctx: TargeterCtx): Enemy | null {
    if (this.lockedTarget && this.lockedTarget.alive) {
      return this.lockedTarget;
    }
    this.lockedTarget = null;
    let bestTarget: Enemy | null = null;
    let bestDot = -1;
    const camFwdW = new THREE.Vector3();
    ctx.activeCamera.getWorldDirection(camFwdW);
    const camFwdVec = v3(camFwdW.x, camFwdW.y, camFwdW.z);
    for (const enemy of ctx.enemies) {
      if (!enemy.alive) continue;
      const dir = norm(sub(enemy.state.r, ctx.player.state.r));
      const d = dot(camFwdVec, dir);
      if (d > bestDot) {
        bestDot = d;
        bestTarget = enemy;
      }
    }
    return bestTarget;
  }
}
