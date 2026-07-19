import { Elements } from '../physics/orbital';
import { Vec3 } from '../physics/vec3';
import { Hud } from './hud';
import { MarkersCtx, MarkersSystem, ProjectFn as MarkerProjectFn } from './markers';
import { MapPlanner, PlannerCtx } from './planner';
import { OrbitLineSystem, OrbitLineUpdateCtx } from './orbit-line-system';

interface HudSyncCtx {
  dt: number;
  origin: Vec3;
  playerVelocity: Vec3;
  mapMode: boolean;
  playerAlive: boolean;
  planner: MapPlanner;
  plannerCtx: PlannerCtx;
  markersCtx: MarkersCtx;
  orbitLineCtx: OrbitLineUpdateCtx;
  project: MarkerProjectFn;
  onGuideAchieved: () => void;
}

export class HudSyncSystem {
  constructor(
    private readonly hud: Hud,
    private readonly markers: MarkersSystem,
    private readonly orbitLines: OrbitLineSystem,
  ) {}

  sync(ctx: HudSyncCtx): void {
    const { playerEl, tgtEl } = this.orbitLines.update(ctx.orbitLineCtx);
    this.updateMarkers(ctx, playerEl, tgtEl);
    this.markers.updateHudPanels(ctx.markersCtx, ctx.dt, playerEl, tgtEl);
    this.hud.tick();
  }

  private updateMarkers(ctx: HudSyncCtx, playerEl: Elements | null, tgtEl: Elements | null): void {
    this.markers.updateMarkers(ctx.markersCtx, ctx.playerVelocity, ctx.project);
    this.markers.updateNodeMarkers(ctx.markersCtx, playerEl, tgtEl, ctx.project);
    this.markers.updateBoardMarkers(ctx.markersCtx, ctx.dt, ctx.project);
    if (!ctx.mapMode) {
      const { achieved } = ctx.planner.updateGuide(
        ctx.plannerCtx,
        ctx.origin,
        ctx.playerVelocity,
        playerEl,
        ctx.playerAlive,
        ctx.project,
      );
      if (achieved) ctx.onGuideAchieved();
      return;
    }
    this.hud.hideMarker('burn');
  }
}
