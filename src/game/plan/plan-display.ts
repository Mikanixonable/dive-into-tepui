// 軌道計画の姿の表示: 計画折れ線(PlanPath)の駆動と、表示時刻の計画上の自機位置ゴースト
// (⬢ plannedPlayer マーカー)。
import * as THREE from 'three/webgpu';
import { Vec3, len, sub } from '../../physics/vec3';
import { CelestialBody, strongestAttractor } from '../../physics/celestial-body';
import type { FrameAnchorSource } from '../../physics/frame';
import { isOccluded } from '../../physics/occlusion';
import { Projected } from '../../physics/projection';
import type { Ephemeris } from '../../physics/ephemeris';
import { SIM_EPOCH_SEC, fmtMarkerDist } from '../hud/utils';
import { celestialBodyName } from '../hud/frame-labels';
import { getApsisLabelSpec } from '../hud/orbit-labels';
import { TickLabelMode, TickRank, calendarBoundaries, elementTimeLabel, tickLabel } from '../hud/calendar-ticks';
import { MarkerManager } from '../marker/marker-manager';
import { ENTITY_GLYPH, ORBIT_POINT_GLYPH } from '../marker/marker-glyphs';
import { ProjectFn, ScaleFn } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { MapPickable } from '../map-pickable';
import * as C from '../const';
import { DisplayDurationSource, PlanData } from './plan';
import { PlanPath } from './plan-path';
import type { DisplayWindow } from '../display-window-manager';
import type { FutureCelestialBodyProvider } from '../simulation/arc-bodies';
import type { Controllable } from '../game-entity/controllable';

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

// ルーラー目盛マーカー。rank は sync 側の間引き・大きさ決めに使う。
interface PlanTickIcon {
  readonly key: string;
  readonly pos: Vec3;
  readonly rank: TickRank;
  readonly label: string;
}

// 衝突マーカーのキー(区間ごとに固定)。区間数は SEGMENT_COLORS(plan-path.ts)と同じ
// 上限で足りる。
const IMPACT_MARKER_KEYS = ['planImpact0', 'planImpact1', 'planImpact2'] as const;

// 半径 radius[px] の点目盛の SVG。投影点を中心に置く前提(CSS 側の .mk 枠中央揃えに乗せる)。
function tickSvg(radius: number): string {
  const size = radius * 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${radius}" cy="${radius}" r="${radius}" fill="currentColor"/></svg>`;
}

// 2点間のスクリーン距離の2乗。
function screenDistSq(a: Projected, b: Projected): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export class PlanDisplay {
  readonly path: PlanPath;

  private apsisIcons: readonly ApsisIcon[] = [];
  private impactIcons: readonly ImpactIcon[] = [];
  private tickIcons: readonly PlanTickIcon[] = [];
  private lastTickKeys: readonly string[] = [];
  private ghost: { readonly pos: Vec3; readonly label: string } | null = null;
  // update が求めた時点の CelestialBody[]。sync でのマップビュー遮蔽判定に使う。
  private celestialBodies: readonly CelestialBody[] = [];

  // 計画折れ線(PlanPath)を構築する。
  constructor(
    scene: THREE.Scene,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
    displayDuration: DisplayDurationSource,
  ) {
    this.path = new PlanPath(scene, displayDuration);
  }

  // 計画折れ線を再積分し、表示時刻のゴースト位置と近地点・遠地点アイコンを求め直す。
  // 起点が null のときは何も求めない — 出さない計画の位置は持たない。ship はノードの無い
  // 唯一の区間を PlanPath が操作対象の予測列として答えるために渡す。
  update(
    planData: PlanData | null, displayWindow: DisplayWindow, celestialBodyProvider: FutureCelestialBodyProvider, ship: Controllable | null,
    frameAnchors: FrameAnchorSource,
  ): void {
    if (planData === null) {
      this.path.clear();
      this.ghost = null;
      this.apsisIcons = [];
      this.impactIcons = [];
      this.tickIcons = [];
      return;
    }
    const { simTime, displayTime } = displayWindow;
    this.celestialBodies = this.ephemeris.celestialBodiesAt(displayTime);
    this.path.update(
      planData, ship, this.ephemeris, displayWindow.frame, simTime, frameAnchors, celestialBodyProvider,
      displayWindow.duration,
    );
    this.ghost = this.ghostAt(displayTime, simTime);
    // 時刻併記の可否・表記は PREDICT パネルの設定(displayWindow 経由)にそのまま従う。
    this.apsisIcons = this.apsisIconsOf(displayWindow.tickLabelMode, displayWindow.showElementTimes, simTime, ship?.name);
    this.impactIcons = this.impactIconsOf();
    this.tickIcons = this.tickIconsOf(displayWindow.tickLabelMode, simTime);
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコンを update が求めた値へ同期する。camera は
  // 折れ線の解像度を決める画面上のサジッタを実距離へ換算するための描画カメラ。
  sync(
    fo: FloatingOrigin, project: ProjectFn, scale: ScaleFn,
    overviewMode: boolean, cameraPos: Vec3, camera: THREE.Camera,
  ): void {
    // ノードの無い計画は自機の現在軌道そのものを描くだけで情報を持たないので、折れ線は隠す。
    // path.sync 自体はノードの有無に関わらず毎フレーム呼ぶ — 画面判定に使う project を
    // 毎フレーム更新しておかないと、クリック当たり判定が古い視点のまま行われてしまう。
    this.path.setVisible(this.path.nodeCount > 0);
    this.path.sync(fo, project, scale, cameraPos, camera);
    this.syncGhost(project, overviewMode, cameraPos);
    this.syncApsisMarkers(project, overviewMode, cameraPos);
    this.syncImpactMarkers(project, overviewMode, cameraPos);
    this.syncTickMarkers(project, overviewMode, cameraPos);
  }

  // 計画折れ線を片付ける。
  dispose(): void {
    this.path.dispose();
  }

  // 計画折れ線・ゴーストマーカー・アプシスアイコンを非表示にする。
  hide(): void {
    this.path.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.markerManager.hide('apsisPe');
    this.markerManager.hide('apsisAp');
    for (const key of IMPACT_MARKER_KEYS) this.markerManager.hide(key);
    for (const key of this.lastTickKeys) this.markerManager.remove(key);
    this.lastTickKeys = [];
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

  // displayTime における計画上の自機位置とそのラベル。折れ線の届く範囲外、または
  // ノードが1つも無ければ null — ノード無しの計画は実軌道の追従コピーでしかなく、
  // 実軌道とのズレを示すゴーストとしては意味を持たない。
  private ghostAt(displayTime: number, simTime: number): { pos: Vec3; label: string } | null {
    if (this.path.nodeCount === 0) return null;
    const sample = this.path.sampleAt(displayTime);
    if (!sample) return null;
    return {
      pos: this.path.toDisplay(sample.r, displayTime),
      label: this.plannedPlayerLabel(displayTime, simTime, sample.r),
    };
  }

  // ⬢ ゴーストマーカーを計画位置に置く。計画がそこまで届いていなければ隠す。
  private syncGhost(project: ProjectFn, overviewMode: boolean, cameraPos: Vec3): void {
    if (!this.ghost) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    if (overviewMode && isOccluded(cameraPos, this.ghost.pos, this.celestialBodies)) {
      this.markerManager.fadeOut('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer', 'mk-planned', ENTITY_GLYPH.ghost, this.ghost.pos, project, this.ghost.label,
    );
  }

  // ゴーストマーカーのラベル文字列(経過時間+高度)を組み立てる。現在時刻のゴーストは
  // 計画どおりに飛べていれば自機に重なるので、経過時間を添えず高度だけを出す。
  // 高度はその位置で最も強く引く天体の表面からの高さ。
  private plannedPlayerLabel(displayTime: number, simTime: number, r: Vec3): string {
    const tRel = displayTime - simTime;
    const center = strongestAttractor(r, this.celestialBodies);
    const alt = len(sub(r, center.state.r)) - center.radius;
    if (tRel <= 0) return `計画位置 高度 ${fmtMarkerDist(alt, 0)}`;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 最後のバーン後の軌道(これから乗る軌道)の近地点・遠地点アイコンを、PlanPath が積分中
  // から直接拾った末尾区間の極値から組み立てる。衝突コースの区間では近地点に達する前に
  // 地表へ達するため近地点が null になるのは正常な挙動であり、そのときはアイコンを出さない。
  // 両方揃っているときだけ、2点の中心からの距離比から離心率相当の値を求め、ほぼ円
  // (APSIS_MIN_ECC 未満)なら方向が不定として両方隠す — 片方しか無い場合(双曲線軌道等)は
  // この判定自体を行わず、そのまま出す。
  private apsisIconsOf(
    mode: TickLabelMode, showTime: boolean, nowSimTime: number, ownerName?: string,
  ): readonly ApsisIcon[] {
    const final = this.path.finalSegment();
    if (!final) return [];
    const pe = final.periapsis;
    const ap = final.apoapsis;

    // 中心天体は極値を検出したときと同じもの(区間が持つ apsisCenter)を使い、その位置だけを
    // 極値の時刻で引き直す — 距離を測る基準が検出時と食い違わないようにするため。
    const center = final.apsisCenter;
    let peDist = 0;
    let peCenter: CelestialBody | null = null;
    if (pe && center) {
      peCenter = center;
      peDist = len(sub(pe.r, this.ephemeris.positionOf(center.id, pe.t)));
    }
    let apDist = 0;
    let apCenter: CelestialBody | null = null;
    if (ap && center) {
      apCenter = center;
      apDist = len(sub(ap.r, this.ephemeris.positionOf(center.id, ap.t)));
    }
    if (pe && ap && (apDist - peDist) / (apDist + peDist) < C.APSIS_MIN_ECC) return [];

    const namePrefix = ownerName ? (this.path.nodeCount > 0 ? `${ownerName} (計画)` : ownerName) : undefined;
    const labelWithTime = (base: string, t: number): string =>
      showTime ? `${base} ${elementTimeLabel(t, mode, nowSimTime)}` : base;
    const icons: ApsisIcon[] = [];
    if (pe && peCenter) {
      const peSpec = getApsisLabelSpec('pe', peCenter.id);
      icons.push({
        id: 'apsisPe', name: peSpec.nameJa, kind: 'apsis',
        ownerName: namePrefix,
        pos: this.path.toDisplay(pe.r, pe.t),
        time: pe.t,
        label: labelWithTime(peSpec.short, pe.t),
      });
    }
    if (ap && apCenter) {
      const apSpec = getApsisLabelSpec('ap', apCenter.id);
      icons.push({
        id: 'apsisAp', name: apSpec.nameJa, kind: 'apsis',
        ownerName: namePrefix,
        pos: this.path.toDisplay(ap.r, ap.t),
        time: ap.t,
        label: labelWithTime(apSpec.short, ap.t),
      });
    }
    return icons;
  }

  // 天体衝突が検出された地点(区間ごとに高々1つ)。衝突天体は判定そのもの(積分弧)が
  // 返したものをそのまま使う — ここで中心天体を引き直すと、判定に使った天体・時刻と
  // 一致しない高度が出かねない。
  private impactIconsOf(): readonly ImpactIcon[] {
    return this.path.impactPoints().flatMap(({ state, body, arcIdx }) => {
      const key = IMPACT_MARKER_KEYS[arcIdx];
      if (key === undefined) return [];
      return [{ key, pos: this.path.toDisplay(state.r, state.t), label: `衝突 ${celestialBodyName(body.id)}` }];
    });
  }

  // 表示中の折れ線が暦の区切り(時・日・月・年)を跨ぐ地点の目盛候補。実際に出すかどうかの
  // 間引きは画面判定が要るので sync 側(syncTickMarkers)の仕事。ラベルは mode に応じて
  // UTC カレンダーか simTime からの経過時間で書く — 目盛りを置く位置は暦の区切りのまま。
  private tickIconsOf(mode: TickLabelMode, simTime: number): readonly PlanTickIcon[] {
    const range = this.path.timeRange();
    if (!range) return [];
    const boundaries = calendarBoundaries(
      SIM_EPOCH_SEC + range.min, SIM_EPOCH_SEC + range.max,
      C.PLAN_TICK_MAX_COUNT, C.PLAN_TICK_HOUR_FAMILY_MAX_COUNT,
    );
    const icons: PlanTickIcon[] = [];
    for (const b of boundaries) {
      const t = b.unix - SIM_EPOCH_SEC;
      const state = this.path.sampleAt(t);
      if (!state) continue;
      icons.push({
        key: `planTick:${b.unix}`,
        pos: this.path.toDisplay(state.r, t),
        rank: b.rank,
        label: tickLabel(b.unix, b.rank, mode, SIM_EPOCH_SEC + simTime),
      });
    }
    return icons;
  }

  // ◇ アプシスアイコンを update が求めた位置に置き、出ていないもの・マップビューで天体に
  // 遮蔽されているものを隠す。
  private syncApsisMarkers(project: ProjectFn, overviewMode: boolean, cameraPos: Vec3): void {
    for (const key of ['apsisPe', 'apsisAp'] as const) {
      const icon = this.apsisIcons.find((m) => m.id === key);
      if (!icon) {
        this.markerManager.hide(key);
      } else if (overviewMode && isOccluded(cameraPos, icon.pos, this.celestialBodies)) {
        this.markerManager.fadeOut(key);
      } else {
        this.markerManager.setPosition(key, 'mk-apsis', ORBIT_POINT_GLYPH.apsis, icon.pos, project, icon.label);
      }
    }
  }

  // ✕ 衝突マーカーを update が求めた位置に置き、出ていないものを隠す。
  private syncImpactMarkers(project: ProjectFn, overviewMode: boolean, cameraPos: Vec3): void {
    for (const key of IMPACT_MARKER_KEYS) {
      const icon = this.impactIcons.find((m) => m.key === key);
      if (!icon) {
        this.markerManager.hide(key);
      } else if (overviewMode && isOccluded(cameraPos, icon.pos, this.celestialBodies)) {
        this.markerManager.fadeOut(key);
      } else {
        this.markerManager.setPosition(key, 'mk-impact', ORBIT_POINT_GLYPH.impact, icon.pos, project, icon.label);
      }
    }
  }

  // update が求めた目盛候補を画面距離で間引いて置く。粗い階数(月・年)から順に軌道順で
  // 採否を決め、既に採用済みの目盛から PLAN_TICK_MIN_PX 未満しか離れない候補は捨てる —
  // 離心軌道では近地点付近と遠地点付近で候補の画面間隔が桁違いになるため、区間全体で
  // 一つの単位に揃えず、この局所判定に任せることで区間ごとに異なる単位が選ばれてよい。
  private syncTickMarkers(project: ProjectFn, overviewMode: boolean, cameraPos: Vec3): void {
    const icons = this.tickIcons;
    const n = icons.length;
    const projected = icons.map((icon) => project(icon.pos));
    const shown = new Array<boolean>(n).fill(false);

    const ranksDesc = [...new Set(icons.map((icon) => icon.rank))].sort((a, b) => b - a);
    const minPxSq = C.PLAN_TICK_MIN_PX ** 2;
    for (const rank of ranksDesc) {
      for (let i = 0; i < n; i++) {
        if (icons[i]!.rank !== rank || !projected[i]!.front
          || (overviewMode && isOccluded(cameraPos, icons[i]!.pos, this.celestialBodies))) continue;
        if (this.isFarFromShown(projected, shown, i, minPxSq)) shown[i] = true;
      }
    }

    // 実際に採用された目盛のうち最も細かい階数を基準に、相対的な深さで大きさを決める
    // — 基準を相対にすることで、単位が切り替わっても目盛の平均的な大きさは変わらず、
    // 切り替わり地点そのものだけが大きさの違いとして目に付く。
    let finestShown: TickRank | null = null;
    for (let i = 0; i < n; i++) {
      if (shown[i] && (finestShown === null || icons[i]!.rank < finestShown)) finestShown = icons[i]!.rank;
    }
    const labelMinPxSq = C.PLAN_TICK_LABEL_MIN_PX ** 2;
    const maxDepth = C.PLAN_TICK_RADIUS_PX.length - 1;

    for (let i = 0; i < n; i++) {
      const icon = icons[i]!;
      const occluded = overviewMode && isOccluded(cameraPos, icon.pos, this.celestialBodies);
      if (!shown[i] || occluded) {
        if (occluded) this.markerManager.fadeOut(icon.key);
        else this.markerManager.hide(icon.key);
        continue;
      }
      const p = projected[i]!;
      const depth = finestShown === null ? 0 : Math.min(Math.max(icon.rank - finestShown, 0), maxDepth);
      const label = this.isFarFromShown(projected, shown, i, labelMinPxSq) ? icon.label : '';
      this.markerManager.set(
        icon.key, 'mk-plantick', tickSvg(C.PLAN_TICK_RADIUS_PX[depth]!), p.x, p.y, true,
        label, 1, undefined, undefined, true,
      );
    }
    // 候補の暦区切り自体が前フレームと入れ替わった分は hide でなく remove で消す
    // (equator-node-markers.ts の syncと同じ規約)。
    const keys = icons.map((icon) => icon.key);
    for (const key of this.lastTickKeys) if (!keys.includes(key)) this.markerManager.remove(key);
    this.lastTickKeys = keys;
  }

  // 軌道順で i の前後にある「採用済み(shown)」の目盛それぞれとの画面距離の2乗が、
  // どちらも minDSq 以上離れているか(採用済みの近傍が片側に無ければその側は無条件で満たす)。
  private isFarFromShown(
    projected: readonly Projected[], shown: readonly boolean[], i: number, minDSq: number,
  ): boolean {
    for (let j = i - 1; j >= 0; j--) {
      if (!shown[j]) continue;
      if (screenDistSq(projected[j]!, projected[i]!) < minDSq) return false;
      break;
    }
    for (let j = i + 1; j < shown.length; j++) {
      if (!shown[j]) continue;
      if (screenDistSq(projected[j]!, projected[i]!) < minDSq) return false;
      break;
    }
    return true;
  }
}
