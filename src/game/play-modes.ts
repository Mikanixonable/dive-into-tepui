import * as THREE from 'three/webgpu';
import { dot, norm, sub, v3 } from '../physics/vec3';
import * as C from './const';
import { Enemy } from './entities';
import { Player } from './player';
import { Hud } from '../hud/hud';
import { Input } from './input';
import { MapPlanner, PlannerCtx, ProjectFn } from './planner';
import { MapView } from './mapview';

export interface PlayModeUpdateCtx {
  mapMode: boolean;
  player: Player;
  enemies: Enemy[];
  planner: MapPlanner;
  plannerCtx: PlannerCtx;
  mapView: MapView;
  input: Input;
  dt: number;
  activeCamera: THREE.PerspectiveCamera;
  fineAttitude: boolean;
  project: ProjectFn;
}

export class PlayModes {
  private lockedTarget: Enemy | null = null;

  constructor(private readonly hud: Hud) {}

  update(ctx: PlayModeUpdateCtx, prevTarget: Enemy | null): Enemy | null {
    if (ctx.mapMode) {
      this.updateMapEditing(ctx);
      return prevTarget;
    }
    return this.updateCombatTargeting(ctx);
  }

  private updateMapEditing(ctx: PlayModeUpdateCtx): void {
    ctx.planner.updateEditing(ctx.dt, ctx.plannerCtx, ctx.input, ctx.project, {
      fineAttitude: ctx.fineAttitude,
      mapSliderT: ctx.mapView.sliderT,
      mapFocus: ctx.mapView.focus,
      labels: ctx.mapView.labels,
    });
  }

  private updateCombatTargeting(ctx: PlayModeUpdateCtx): Enemy | null {
    ctx.input.takeClicks();
    this.handleTargetLockByRightClick(ctx);
    return this.resolveAutoTarget(ctx);
  }

  private handleTargetLockByRightClick(ctx: PlayModeUpdateCtx): void {
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

  private resolveAutoTarget(ctx: PlayModeUpdateCtx): Enemy | null {
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
