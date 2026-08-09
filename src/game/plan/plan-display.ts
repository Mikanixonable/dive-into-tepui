// 軌道計画の姿の表示: 計画折れ線(PlanPath)の駆動、表示座標系(planFrame)、
// 表示時刻の計画上の自機位置ゴースト(⬡ plannedPlayer マーカー)。
import * as THREE from 'three/webgpu';
import { Vec3, len, sub } from '../../physics/vec3';
import { Attractor, strongestAttractor } from '../../physics/attractor';
import { apparentEccentricity, findApsis } from '../../physics/trajectory-features';
import { isOccluded } from '../../physics/occlusion';
import { ReferenceFrame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import { SIM_EPOCH_SEC, fmtMarkerDist, fmtDist } from '../hud/utils';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn, ScaleFn } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { SegmentedControl } from '../hud/buttons';
import { frameItems } from '../hud/frame-labels';
import { MapPickable } from '../map-pick';
import * as C from '../const';
import { hudDock } from '../hud/dom';
import { Plan } from './plan';
import { PlanPath } from './plan-path';
import type { DisplayTimeManager } from '../display-time-manager';

// 近地点・遠地点アイコン。右クリックの被選択物であると同時に、表示するラベルを持つ。
interface ApsisIcon extends MapPickable {
  readonly label: string;
}

// ✕ 衝突マーカー(区間ごとに高々1つ)
interface ImpactIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly label: string;
}

// │ 日付境界の目盛マーカー
interface DayTickIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly label: string;
}

// 衝突マーカーのキー(区間ごとに固定)。区間数は SEGMENT_COLORS(plan-trajectory.ts)と同じ
// 上限で足りる。
const IMPACT_MARKER_KEYS = ['planImpact0', 'planImpact1', 'planImpact2'] as const;

export class PlanDisplay {
  planFrame: ReferenceFrame;

  readonly path: PlanPath;

  private readonly panel: HTMLElement;
  private readonly frame: SegmentedControl<ReferenceFrame>;
  private apsisIcons: readonly ApsisIcon[] = [];
  private impactIcons: readonly ImpactIcon[] = [];
  private dayTickIcons: readonly DayTickIcon[] = [];
  private lastDayTickCount = 0;
  private ghost: { readonly pos: Vec3; readonly label: string } | null = null;
  private plan: Plan | null = null;
  // update が求めた時点の Attractor[]。sync でのマップビュー遮蔽判定に使う。
  private attractors: readonly Attractor[] = [];
  // 直近に TRAJECTORY パネルの選択肢を組んだ重力天体 id の集合。変化した回だけ組み直す。
  private lastDynamicIds = '';

  // 計画折れ線(PlanPath)と TRAJECTORY パネルの DOM を構築する。
  constructor(
    scene: THREE.Scene,
    hudRoot: HTMLElement,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
    displayTimeManager: DisplayTimeManager,
  ) {
    this.planFrame = ephemeris.inertialFrame;
    this.path = new PlanPath(scene, displayTimeManager);

    // TRAJECTORY パネルの DOM を組み立てる
    this.panel = document.createElement('div');
    this.panel.id = 'hud-trajframe';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'TRAJECTORY';
    this.panel.appendChild(title);
    // 表示座標系の切り替えボタン
    this.frame = new SegmentedControl<ReferenceFrame>('軌道', frameItems(ephemeris, []), (frame) => { this.planFrame = frame; });
    this.panel.appendChild(this.frame.element);
    hudDock(hudRoot, 'left').appendChild(this.panel);
  }

  // 計画折れ線を再積分し、表示時刻のゴースト位置と近地点・遠地点アイコンを求め直す。
  // show=false のときは何も求めない — 出さない計画の位置は持たない。
  update(
    plan: Plan, simTime: number, displayTime: number, show: boolean,
    dynamicAttractors: readonly Attractor[],
  ): void {
    this.plan = show ? plan : null;
    if (!show) {
      this.ghost = null;
      this.apsisIcons = [];
      this.impactIcons = [];
      this.dayTickIcons = [];
      return;
    }
    this.attractors = this.ephemeris.attractorsAt(displayTime);
    this.refreshFrameItems();
    this.path.update(plan, this.ephemeris, this.planFrame, simTime, this.attractors, dynamicAttractors);
    this.ghost = this.ghostAt(plan, displayTime, simTime);
    this.apsisIcons = this.apsisIconsOf();
    this.impactIcons = this.impactIconsOf();
    this.dayTickIcons = this.dayTickIconsOf();
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコンを update が求めた値へ同期する。
  // TRAJECTORY パネルは表示座標系を選ぶ操作 UI なので、操作を受け付けるときだけ showPanel で出す。
  sync(
    fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn, showPanel: boolean,
    overviewMode: boolean, cameraPos: Vec3,
  ): void {
    // ノードの無い計画は自機の現在軌道そのものを描くだけで情報を持たないので、折れ線は隠す。
    // path.sync 自体はノードの有無に関わらず毎フレーム呼ぶ — 画面判定に使う project を
    // 毎フレーム更新しておかないと、クリック当たり判定が古い視点のまま行われてしまう。
    this.path.setVisible((this.plan?.nodes.length ?? 0) > 0);
    this.path.sync(fo, project, scale, cameraPos);
    this.syncGhost(project);
    this.syncApsisMarkers(project, overviewMode, cameraPos);
    this.syncImpactMarkers(project);
    this.syncDayTickMarkers(project);
    this.panel.style.display = showPanel ? 'block' : 'none';
    this.frame.setSelected(this.planFrame);
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコン・TRAJECTORY パネルを非表示にする。
  hide(): void {
    this.path.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.markerManager.hide('apsisPe');
    this.markerManager.hide('apsisAp');
    for (const key of IMPACT_MARKER_KEYS) this.markerManager.hide(key);
    for (let i = 0; i < this.lastDayTickCount; i++) this.markerManager.hide(`planDayTick${i}`);
    this.lastDayTickCount = 0;
    this.panel.style.display = 'none';
  }

  // 近地点・遠地点アイコンの右クリック候補(非表示中は空)。
  get apsisMarkers(): readonly MapPickable[] {
    return this.apsisIcons;
  }

  // アプシスアイコン id に対応する通過時刻。アイコンが出ていない id では null。
  apsisTimeOf(id: string): number | null {
    const icon = this.apsisIcons.find((i) => i.id === id);
    return icon?.time ?? null;
  }

  // 生存中の重力天体の増減を反映して TRAJECTORY パネルの座標系選択肢を組み直す
  // (登録天体は変わらないので変化しない回は何もしない)。
  private refreshFrameItems(): void {
    const dynamicIds = this.attractors.filter((a) => !(a.id in this.ephemeris.registry)).map((a) => a.id).join(',');
    if (dynamicIds === this.lastDynamicIds) return;
    this.lastDynamicIds = dynamicIds;
    this.frame.setItems(frameItems(this.ephemeris, this.attractors));
  }

  // displayTime における計画上の自機位置とそのラベル。折れ線の届く範囲外、または
  // ノードが1つも無ければ null — ノード無しの計画は実軌道の追従コピーでしかなく、
  // 実軌道とのズレを示すゴーストとしては意味を持たない。
  private ghostAt(plan: Plan, displayTime: number, simTime: number): { pos: Vec3; label: string } | null {
    if (plan.nodes.length === 0) return null;
    const sample = this.path.sampleAt(displayTime);
    if (!sample) return null;
    return {
      pos: this.path.toDisplay(sample.r, displayTime),
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

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、実際に描かれている
  // 積分折れ線(finalSegmentSamples)を走査して求める — 解析要素はエポックが動くだけで
  // J2 短周期振動ぶん値が変わるため、Δv=0 のノードを置いても線の上のアイコンが動かない
  // ようにするには、ノードの有無に関わらず同じ折れ線から拾う必要がある。
  // apparentEccentricity がほぼ0(円に近い)なら方向が不定として両方隠す。
  private apsisIconsOf(): readonly ApsisIcon[] {
    const state0 = this.path.finalSegmentStart;
    const samples = this.path.finalSegmentSamples;
    if (!state0 || !samples || !this.plan) return [];
    const center = strongestAttractor(state0.r, this.ephemeris.attractorsAt(state0.t));
    if (apparentEccentricity(samples, center) < C.APSIS_MIN_ECC) return [];

    const icons: ApsisIcon[] = [];
    const pe = findApsis(samples, center, 'periapsis');
    if (pe) {
      icons.push({
        id: 'apsisPe', name: '近地点', kind: 'apsis',
        pos: this.path.toDisplay(pe.r, pe.t),
        time: pe.t,
        label: `Pe ${fmtDist(len(sub(pe.r, center.state.r)) - center.radius)}`,
      });
    }
    const ap = findApsis(samples, center, 'apoapsis');
    if (ap) {
      icons.push({
        id: 'apsisAp', name: '遠地点', kind: 'apsis',
        pos: this.path.toDisplay(ap.r, ap.t),
        time: ap.t,
        label: `Ap ${fmtDist(len(sub(ap.r, center.state.r)) - center.radius)}`,
      });
    }
    return icons;
  }

  // 天体衝突が検出された地点(区間ごとに高々1つ)。その地点で最も強く引く天体の表面からの
  // 高度をラベルに添える。
  private impactIconsOf(): readonly ImpactIcon[] {
    return this.path.impactPoints().flatMap(({ state, arcIdx }) => {
      const key = IMPACT_MARKER_KEYS[arcIdx];
      if (key === undefined) return [];
      const center = strongestAttractor(state.r, this.ephemeris.attractorsAt(state.t));
      const alt = len(sub(state.r, center.state.r)) - center.radius;
      return [{ key, pos: this.path.toDisplay(state.r, state.t), label: `衝突 高度 ${fmtMarkerDist(alt, 0)}` }];
    });
  }

  // 表示中の折れ線が UTC 日付境界(0時0分0秒)を跨ぐ地点のアイコン。ラベルは UTC の日付。
  private dayTickIconsOf(): readonly DayTickIcon[] {
    return this.path.dayBoundaries().map(({ t, pos }, i) => {
      const d = new Date((SIM_EPOCH_SEC + t) * 1000);
      return {
        key: `planDayTick${i}`,
        pos: this.path.toDisplay(pos, t),
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      };
    });
  }

  // ◇ アプシスアイコンを update が求めた位置に置き、出ていないもの・マップビューで天体に
  // 遮蔽されているものを隠す。
  private syncApsisMarkers(project: ProjectFn, overviewMode: boolean, cameraPos: Vec3): void {
    for (const key of ['apsisPe', 'apsisAp'] as const) {
      const icon = this.apsisIcons.find((m) => m.id === key);
      if (icon && !(overviewMode && isOccluded(cameraPos, icon.pos, this.attractors))) {
        this.markerManager.setPosition(key, 'mk-apsis', '◇', icon.pos, project, icon.label);
      } else {
        this.markerManager.hide(key);
      }
    }
  }

  // ✕ 衝突マーカーを update が求めた位置に置き、出ていないものを隠す。
  private syncImpactMarkers(project: ProjectFn): void {
    for (const key of IMPACT_MARKER_KEYS) {
      const icon = this.impactIcons.find((m) => m.key === key);
      if (icon) this.markerManager.setPosition(key, 'mk-impact', '✕', icon.pos, project, icon.label);
      else this.markerManager.hide(key);
    }
  }

  // │ 日付境界の目盛マーカーを update が求めた位置に置く。件数が可変なので、前フレームより
  // 減った分だけ隠す(固定キー集合を持つ他のアイコンとは異なり、キー自体が個数ぶん増減する)。
  private syncDayTickMarkers(project: ProjectFn): void {
    for (const icon of this.dayTickIcons) {
      this.markerManager.setPosition(icon.key, 'mk-daytick', '│', icon.pos, project, icon.label);
    }
    for (let i = this.dayTickIcons.length; i < this.lastDayTickCount; i++) {
      this.markerManager.hide(`planDayTick${i}`);
    }
    this.lastDayTickCount = this.dayTickIcons.length;
  }
}
