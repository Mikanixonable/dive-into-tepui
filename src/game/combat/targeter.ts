import * as THREE from 'three/webgpu';
import { dot, norm, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { Enemy } from '../enemy/enemy';
import { Player } from '../player/player';
import { Hud } from '../../hud/hud';
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

  constructor(private readonly hud: Hud) {}

  updateCombatTargeting(ctx: TargeterCtx): Enemy | null {
    ctx.input.takeClicks();
    this.handleTargetLockByRightClick(ctx);
    return this.resolveAutoTarget(ctx);
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
      this.hud.hint('ターゲット固定解除');
    }
  }

  private toggleLockedTarget(hit: Enemy): void {
    if (this.lockedTarget === hit) {
      this.lockedTarget = null;
      this.hud.hint('ターゲット固定解除');
      return;
    }
    this.lockedTarget = hit;
    this.hud.hint(`ターゲット固定: ${hit.name}`);
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
