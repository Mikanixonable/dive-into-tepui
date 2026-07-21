// マップモード上での軌道計画(Plan)の表示: 予測軌道の折れ線・未来ゴーストマーカー、
// および「太陽回転系」表示の座標変換(toDisplayFrame)。予測の再計算(Plan.trajSamples
// の更新)と同じタイミングで回転基準角(trajYawRef)を固定する必要がある(次の
// 再計算までクリック判定と描画を一致させるため)ので、それを担う plan-editor.ts の
// クリックピッキングも toDisplayFrame はここに委譲する — 二重に基準角を持つと
// ずれが生じるため、正はここ一箇所のみ。
// mapMode 中のみ意味を持つ。
import { Elements, R_EARTH, elementsFromState } from '../../physics/orbital';
import { sunAzimuth } from '../../physics/ephemeris';
import { TrajectorySample } from '../../physics/predict';
import { Vec3, len, rotateAxis, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { fmtMarkerDist } from '../../hud/utils';
import { TrajLine } from '../../render/trajline';
import { MarkerManager } from '../../hud/markerManager';
import { ProjectFn } from '../camera/camera-system';
import { Plan } from './plan';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

// plan-editor.ts のクリック判定・ドラッグへ渡す、太陽回転系表示込みの座標変換。
// PlanDisplay.toDisplayFrame を ctx/mapFrameRotating で束縛したクロージャ
// (map-mode-system.ts が毎フレーム作る)を型として共有する。
export type DisplayFrameFn = (r: Vec3, t: number) => Vec3;

export class PlanDisplay {
  readonly line = new TrajLine();
  predictDurationKey: PredictDurationKey = 'day';

  // 直近の refresh() 時点で固定した表示回転角。同じ trajSamples を指している間は
  // クリック判定(plan-editor.ts)・描画とも同じ値を使う。
  private trajYawRef = 0;
  private lastSeenSamples: readonly TrajectorySample[] | null = null;

  constructor(private readonly markers: MarkerManager) {}

  // 選んだ期間だけ予測する(マップモードでの表示用— 戦闘ビューの噴射ガイド用の
  // 期間は plan-guide.ts の guideDurationSec が別途持つ)。
  predictDurationSec(player: Player): number {
    if (this.predictDurationKey === 'orbit') {
      const el: Elements | null = elementsFromState(player.state.r, player.state.v);
      if (el && isFinite(el.period) && el.period > 0) return el.period;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  // ECI 座標 r(時刻 t のもの)をマップの「太陽回転系」表示用に回転させる
  // (非回転系なら無変換)。plan-editor.ts のクリック判定・ドラッグも同じ変換を使う。
  toDisplayFrame(r: Vec3, t: number, ephemeris: EphemerisSystem, mapFrameRotating: boolean): Vec3 {
    if (!mapFrameRotating) return r;
    const phi = this.trajYawRef - sunAzimuth(t, ephemeris.sunPhase0);
    return rotateAxis(r, v3(0, 1, 0), phi);
  }

  displayTime(simTime: number, duration: number, sliderT: number): number {
    return simTime + sliderT * duration;
  }

  // 未来位置ゴースト(スライダー)のラベル文字列
  ghostLabel(plan: Plan, player: Player, simTime: number, sliderT: number): string {
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration, sliderT);
    const s = plan.sampleAt(t);
    if (!s) return '';
    const tRel = t - simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  hide(): void {
    this.line.setVisible(false);
    this.markers.hide('ghost');
  }

  // 毎フレーム(マップモード中のみ呼ぶ): 予測を最新化し、折れ線・ゴーストマーカーを更新する。
  update(
    plan: Plan,
    { player, ephemeris, simTime }: { player: Player; ephemeris: EphemerisSystem; simTime: number },
    origin: Vec3,
    mapFrameRotating: boolean,
    sliderT: number,
    project: ProjectFn,
  ): void {
    this.line.setVisible(true);
    this.line.setOrigin(origin);
    plan.maybeRefresh(player, ephemeris, simTime, this.predictDurationSec(player));

    // trajSamples の参照が変わった(=予測が再計算された)フレームでだけ、折れ線の
    // ジオメトリと表示回転角(trajYawRef)を作り直す。
    if (plan.trajSamples !== this.lastSeenSamples) {
      this.lastSeenSamples = plan.trajSamples;
      this.trajYawRef = mapFrameRotating ? sunAzimuth(simTime, ephemeris.sunPhase0) : 0;
      this.rebuildGeometry(plan, ephemeris, mapFrameRotating);
    }

    if (sliderT <= 0 || plan.trajSamples.length <= 0) {
      this.markers.hide('ghost');
      return;
    }
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration, sliderT);
    const sample = plan.sampleAt(t);
    if (!sample) {
      this.markers.hide('ghost');
      return;
    }
    const p = project(sub(this.toDisplayFrame(sample.r, t, ephemeris, mapFrameRotating), origin));
    this.markers.set('ghost', 'mk-ghost', '⬡', p.x, p.y, p.front, this.ghostLabel(plan, player, simTime, sliderT));
  }

  private rebuildGeometry(plan: Plan, ephemeris: EphemerisSystem, mapFrameRotating: boolean): void {
    const nodeTimes = plan.nodes.map((n) => n.time);
    const segments: Vec3[][] = [];
    let segment: Vec3[] = [];
    let nodeIdx = 0;
    for (const sample of plan.trajSamples) {
      segment.push(this.toDisplayFrame(sample.r, sample.t, ephemeris, mapFrameRotating));
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
