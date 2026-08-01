// 軌道計画の未来表示: 予測折れ線(PlanTrajectory)の駆動、表示座標系(trajectoryFrame)、
// 未来ゴースト(⬡ plannedPlayer マーカー)。
import * as THREE from 'three/webgpu';
import { R_EARTH, elementsFromState, positionOnOrbit, tofBetween, trueAnomalyAt } from '../../physics/orbital';
import { Vec3, len } from '../../physics/vec3';
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
import { Plan } from './plan';
import { PlanTrajectory } from './plan-trajectory';

export class PlanDisplay {
  trajectoryFrame: Frame = 'inertial';

  readonly traj: PlanTrajectory;

  private readonly panel: HTMLElement;
  private readonly frame: SegmentedControl<Frame>;
  private readonly _apsisMarkers: MapPickable[] = [];

  // 予測折れ線(PlanTrajectory)と TRAJECTORY パネルの DOM を構築する。
  constructor(
    scene: THREE.Scene,
    hudRoot: HTMLElement,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
  ) {
    // 予測折れ線を構築する
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
    hudRoot.appendChild(this.panel);
  }

  // 予測折れ線・ゴーストマーカー・アプシスアイコン・TRAJECTORY パネルを現在のプラン/表示時刻に同期する。
  sync(plan: Plan, displayEnd: number, simTime: number, displayTime: number, fo: FloatingOrigin, project: ProjectFn): void {
    this.traj.setVisible(true);
    this.traj.update(plan, displayEnd, this.ephemeris, this.trajectoryFrame, simTime, fo, project);
    this.syncGhost(displayTime, simTime, project);
    this.syncApsisMarkers(project);
    this.panel.style.display = 'block';
    this.frame.setSelected(this.trajectoryFrame);
  }

  // 予測折れ線・ゴーストマーカー・アプシスアイコン・TRAJECTORY パネルを非表示にする。
  hide(): void {
    this.traj.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.markerManager.hide('apsisPe');
    this.markerManager.hide('apsisAp');
    this._apsisMarkers.length = 0;
    this.panel.style.display = 'none';
  }

  // 近地点・遠地点アイコンの右クリック候補(非表示中は空)。
  get apsisMarkers(): readonly MapPickable[] {
    return this._apsisMarkers;
  }

  // アプシスアイコン id に対応する通過時刻。アイコンが出ていない id では null。
  apsisTimeOf(id: string): number | null {
    const state0 = this.traj.finalSegmentStart;
    if (!state0 || !this._apsisMarkers.some((m) => m.id === id)) return null;
    const el = elementsFromState(state0.r, state0.v);
    if (!el) return null;
    const nu = id === 'apsisAp' ? Math.PI : 0;
    const dt = tofBetween(el, trueAnomalyAt(el, state0.r), nu);
    return isFinite(dt) ? state0.t + dt : null;
  }

  // ⬡ ゴーストマーカーを displayTime の予測位置に同期する。表示時刻が現在以前、
  // または折れ線の予測範囲外なら隠す。
  private syncGhost(displayTime: number, simTime: number, project: ProjectFn): void {
    // 現在時刻以前はゴーストを出さない
    if (displayTime <= simTime) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    // 折れ線の予測範囲外なら隠す
    const sample = this.traj.sampleAt(displayTime);
    if (!sample) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    // 予測位置にマーカーを置く
    this.markerManager.setPosition(
      'plannedPlayer',
      'mk-planned',
      '⬡',
      this.traj.toDisplay(sample.r, displayTime),
      project,
      this.plannedPlayerLabel(displayTime, simTime, sample.r),
    );
  }

  // ゴーストマーカーのラベル文字列(経過時間+高度)を組み立てる。
  private plannedPlayerLabel(displayTime: number, simTime: number, r: Vec3): string {
    const tRel = displayTime - simTime;
    const alt = len(r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、その要素から
  // 解析的に同期する。離心率がほぼ0で方向が不定なら両方隠す。
  private syncApsisMarkers(project: ProjectFn): void {
    this._apsisMarkers.length = 0;
    const state0 = this.traj.finalSegmentStart;
    const el = state0 ? elementsFromState(state0.r, state0.v) : null;
    if (!el || el.e < C.APSIS_MIN_ECC) {
      this.markerManager.hide('apsisPe');
      this.markerManager.hide('apsisAp');
      return;
    }

    const peWorld = this.traj.toDisplay(positionOnOrbit(el, 0), state0!.t);
    this._apsisMarkers.push({ id: 'apsisPe', name: '近地点', pos: peWorld, kind: 'apsis' });
    this.markerManager.setPosition('apsisPe', 'mk-apsis', '◇', peWorld, project, `Pe ${fmtDist(el.peAlt)}`);

    if (isFinite(el.apAlt)) {
      const apWorld = this.traj.toDisplay(positionOnOrbit(el, Math.PI), state0!.t);
      this._apsisMarkers.push({ id: 'apsisAp', name: '遠地点', pos: apWorld, kind: 'apsis' });
      this.markerManager.setPosition('apsisAp', 'mk-apsis', '◇', apWorld, project, `Ap ${fmtDist(el.apAlt)}`);
    } else {
      this.markerManager.hide('apsisAp');
    }
  }
}
