import { sampleAt } from '../../physics/predict';
import { Vec3, sub } from '../../physics/vec3';
import { TrajLine } from '../../render/trajline';
import { MarkerManager } from '../../hud/markerManager';
import { MapPlanner, PlannerCtx } from './planner';
import { ProjectFn } from '../camera/projection';

export class TrajectoryOverlay {
  readonly line = new TrajLine();

  constructor(
    private readonly markers: MarkerManager,
    private readonly planner: MapPlanner,
  ) {}

  predictDurationSec(ctx: PlannerCtx): number {
    return this.planner.predictDurationSec(ctx);
  }

  maybeRefresh(ctx: PlannerCtx): void {
    this.planner.maybeRefresh(ctx);
  }

  updateForMapMode(
    mapMode: boolean,
    origin: Vec3,
    plannerCtx: PlannerCtx,
    simTime: number,
    sliderT: number,
    project: ProjectFn,
    displayTime: (simTime: number, duration: number) => number,
  ): void {
    if (!mapMode) {
      this.line.setVisible(false);
      this.markers.hide('ghost');
      return;
    }
    this.line.setVisible(true);
    this.line.setOrigin(origin);
    if (this.planner.trajGeomDirty) {
      this.rebuildGeometry(plannerCtx);
      this.planner.trajGeomDirty = false;
    }
    if (sliderT <= 0 || this.planner.trajSamples.length <= 0) {
      this.markers.hide('ghost');
      return;
    }
    const duration = this.predictDurationSec(plannerCtx);
    const t = displayTime(simTime, duration);
    const sample = sampleAt(this.planner.trajSamples, t);
    if (!sample) {
      this.markers.hide('ghost');
      return;
    }
    const p = project(sub(this.planner.toDisplayFrame(sample.r, t, plannerCtx), origin));
    this.markers.set('ghost', 'mk-ghost', '⬡', p.x, p.y, p.front, this.planner.ghostLabel(plannerCtx, sliderT));
  }

  private rebuildGeometry(plannerCtx: PlannerCtx): void {
    const nodeTimes = this.planner.planNodes.map((n) => n.time);
    const segments: Vec3[][] = [];
    let segment: Vec3[] = [];
    let nodeIdx = 0;
    for (const sample of this.planner.trajSamples) {
      segment.push(this.planner.toDisplayFrame(sample.r, sample.t, plannerCtx));
      if (nodeIdx < nodeTimes.length && sample.t >= nodeTimes[nodeIdx]! - 1e-6) {
        segments.push(segment);
        segment = [segment[segment.length - 1]!];
        nodeIdx++;
      }
    }
    if (segment.length > 1) segments.push(segment);
    this.line.refresh(segments);
  }
}
