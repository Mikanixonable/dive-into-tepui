// 軌道計画の姿の表示: 計画折れ線(PlanTrajectory)の駆動、表示座標系(trajectoryFrame)、
// 表示時刻の計画上の自機位置ゴースト(⬡ plannedPlayer マーカー)。
import * as THREE from 'three/webgpu';
import { orbitState } from '../../physics/orbital-state';
import { positionOnOrbit, tofBetween, trueAnomalyAt } from '../../physics/elements';
import { Vec3, len, sub } from '../../physics/vec3';
import { elementsAround, relativeTo, strongestAttractor, toAbsolute } from '../../physics/attractor';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { fmtMarkerDist, fmtDist } from '../hud/utils';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { SegmentedControl } from '../hud/buttons';
import { FRAME_ITEMS } from '../hud/frame-labels';
import { MapPickable } from '../map-pick';
import * as C from '../const';
import { hudDock } from '../hud/dom';
import { Plan } from './plan';
import { PlanTrajectory } from './plan-trajectory';

// 近地点・遠地点アイコン。右クリックの被選択物であると同時に、表示するラベルを持つ。
interface ApsisIcon extends MapPickable {
  readonly label: string;
}

export class PlanDisplay {
  trajectoryFrame: Frame = 'inertial';

  readonly traj: PlanTrajectory;

  private readonly panel: HTMLElement;
  private readonly frame: SegmentedControl<Frame>;
  private apsisIcons: readonly ApsisIcon[] = [];
  private ghost: { readonly pos: Vec3; readonly label: string } | null = null;
  private plan: Plan | null = null;

  // 計画折れ線(PlanTrajectory)と TRAJECTORY パネルの DOM を構築する。
  constructor(
    scene: THREE.Scene,
    hudRoot: HTMLElement,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
  ) {
    this.traj = new PlanTrajectory(scene);

    // TRAJECTORY パネルの DOM を組み立てる
    this.panel = document.createElement('div');
    this.panel.id = 'hud-trajframe';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'TRAJECTORY';
    this.panel.appendChild(title);
    // 表示座標系の切り替えボタン
    this.frame = new SegmentedControl<Frame>('軌道', FRAME_ITEMS, (frame) => { this.trajectoryFrame = frame; });
    this.panel.appendChild(this.frame.element);
    hudDock(hudRoot, 'left').appendChild(this.panel);
  }

  // 計画折れ線を再積分し、表示時刻のゴースト位置と近地点・遠地点アイコンを求め直す。
  // show=false のときは何も求めない — 出さない計画の位置は持たない。
  update(plan: Plan, simTime: number, displayTime: number, show: boolean): void {
    this.plan = show ? plan : null;
    if (!show) {
      this.ghost = null;
      this.apsisIcons = [];
      this.traj.resetDivergence();
      return;
    }
    this.traj.update(plan, this.ephemeris, this.trajectoryFrame, simTime);
    this.ghost = this.ghostAt(displayTime, simTime);
    this.apsisIcons = this.apsisIconsOf();
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコンを update が求めた値へ同期する。
  // TRAJECTORY パネルは表示座標系を選ぶ操作 UI なので、操作を受け付けるときだけ showPanel で出す。
  sync(fo: FloatingOrigin, project: ProjectFn, showPanel: boolean): void {
    this.traj.setVisible(true);
    this.traj.sync(fo, project);
    this.syncGhost(project);
    this.syncApsisMarkers(project);
    this.panel.style.display = showPanel ? 'block' : 'none';
    this.frame.setSelected(this.trajectoryFrame);
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコン・TRAJECTORY パネルを非表示にする。
  hide(): void {
    this.traj.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.markerManager.hide('apsisPe');
    this.markerManager.hide('apsisAp');
    this.panel.style.display = 'none';
  }

  // 近地点・遠地点アイコンの右クリック候補(非表示中は空)。
  get apsisMarkers(): readonly MapPickable[] {
    return this.apsisIcons;
  }

  // アプシスアイコン id に対応する通過時刻。アイコンが出ていない id では null。
  apsisTimeOf(id: string): number | null {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this.plan || !this.apsisIcons.some((icon) => icon.id === id)) return null;
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    const relative = relativeTo(state0, center);
    const el = elementsAround(state0, center);
    if (!el) return null;
    const nu = id === 'apsisAp' ? Math.PI : 0;
    const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
    return isFinite(dt) ? state0.t + dt : null;
  }

  // displayTime における計画上の自機位置とそのラベル。折れ線の届く範囲外なら null。
  private ghostAt(displayTime: number, simTime: number): { pos: Vec3; label: string } | null {
    const sample = this.traj.sampleAt(displayTime);
    if (!sample) return null;
    return {
      pos: this.traj.toDisplay(sample.r, displayTime),
      label: this.plannedPlayerLabel(displayTime, simTime, sample.r),
    };
  }

  // ⬡ ゴーストマーカーを計画位置に置く。計画がそこまで届いていなければ隠す。
  private syncGhost(project: ProjectFn): void {
    if (!this.ghost) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer', 'mk-planned', '⬡', this.ghost.pos, project, this.ghost.label,
    );
  }

  // ゴーストマーカーのラベル文字列(経過時間+高度)を組み立てる。現在時刻のゴーストは
  // 計画どおりに飛べていれば自機に重なるので、経過時間を添えず高度だけを出す。
  // 高度はその位置で最も強く引く天体の表面からの高さ。
  private plannedPlayerLabel(displayTime: number, simTime: number, r: Vec3): string {
    const tRel = displayTime - simTime;
    const center = strongestAttractor(r, this.ephemeris.attractorsAt(displayTime));
    const alt = len(sub(r, center.state.r)) - center.radius;
    if (tRel <= 0) return `計画位置 高度 ${fmtMarkerDist(alt, 0)}`;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、その軌道要素から
  // 解析的に求める。離心率がほぼ0で方向が不定なら空、双曲線軌道なら近地点だけ。
  private apsisIconsOf(): readonly ApsisIcon[] {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this.plan) return [];
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    const relative = relativeTo(state0, center);
    const el = elementsAround(state0, center);
    if (!el || el.e < C.APSIS_MIN_ECC) return [];

    const apsisPosition = (nu: number): { pos: Vec3, time: number } => {
      const dt = tofBetween(el, trueAnomalyAt(el, relative.r), nu);
      const t = state0.t + (isFinite(dt) ? dt : 0);
      const relativeState = orbitState(t, positionOnOrbit(el, nu), relative.v);
      return {
        pos: this.traj.toDisplay(toAbsolute(relativeState, center).r, t),
        time: t
      };
    };

    const pe = apsisPosition(0);
    const icons: ApsisIcon[] = [{
      id: 'apsisPe', name: '近地点', kind: 'apsis',
      pos: pe.pos,
      time: pe.time,
      label: `Pe ${fmtDist(el.p / (1 + el.e) - center.radius)}`,
    }];
    if (el.e < 1) {
      const ap = apsisPosition(Math.PI);
      icons.push({
        id: 'apsisAp', name: '遠地点', kind: 'apsis',
        pos: ap.pos,
        time: ap.time,
        label: `Ap ${fmtDist(el.a * (1 + el.e) - center.radius)}`,
      });
    }
    return icons;
  }

  // ◇ アプシスアイコンを update が求めた位置に置き、出ていないものを隠す。
  private syncApsisMarkers(project: ProjectFn): void {
    for (const key of ['apsisPe', 'apsisAp'] as const) {
      const icon = this.apsisIcons.find((m) => m.id === key);
      if (icon) this.markerManager.setPosition(key, 'mk-apsis', '◇', icon.pos, project, icon.label);
      else this.markerManager.hide(key);
    }
  }
}
