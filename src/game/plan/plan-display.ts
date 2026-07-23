// マップモード上での軌道計画(Plan)の表示: 予測軌道の折れ線・未来ゴーストマーカー、
// および「太陽回転系」表示の座標変換(toDisplayFrame)。予測の再計算(Plan.trajSamples
// の更新)と同じタイミングで回転基準角(trajYawRef)を固定する必要がある(次の
// 再計算までクリック判定と描画を一致させるため)ので、それを担う plan-editor.ts の
// クリックピッキングも toDisplayFrame はここに委譲する — 二重に基準角を持つと
// ずれが生じるため、正はここ一箇所のみ。
// mapMode 中のみ意味を持つ。
import * as THREE from 'three/webgpu';
import { Elements, R_EARTH, elementsFromState } from '../../physics/orbital';
import { sunAzimuth } from '../../physics/ephemeris';
import { Vec3, len, rotateAxis, sub, v3 } from '../../physics/vec3';
import * as C from '../const';
import { fmtMarkerDist } from '../../hud/utils';
import { TrajLine } from './trajline';
import { MarkerManager } from '../marker/marker-manager';
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
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴーストマーカー非表示)。
  // カメラの視点計算には無関係な、予測表示側の状態のためここが正(MapCameraには置かない)。
  sliderT = 0;

  // 直近の折れ線再構築(line.sync() が予測更新を検出したタイミング)で固定した
  // 表示回転角。同じ trajSamples を指している間はクリック判定(plan-editor.ts)・
  // 描画とも同じ値を使う。
  private trajYawRef = 0;

  constructor(private readonly markerManager: MarkerManager, private readonly _scene: THREE.Scene) {
    this._scene.add(this.line.group);
  }

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
  // (非回転系なら無変換)。
  private toDisplayFrame(r: Vec3, t: number, ephemeris: EphemerisSystem, mapFrameRotating: boolean): Vec3 {
    if (!mapFrameRotating) return r;
    const phi = this.trajYawRef - sunAzimuth(t, ephemeris.sunPhase0);
    return rotateAxis(r, v3(0, 1, 0), phi);
  }

  // 太陽回転系表示込みの座標変換を束縛したクロージャを返す。plan-editor.ts のクリック
  // 判定・ドラッグ・ギズモ配置は必ずこの1つの変換を通すことで、描画とずれないようにする。
  bindDisplayFrame(ephemeris: EphemerisSystem, mapFrameRotating: boolean): DisplayFrameFn {
    return (r: Vec3, t: number) => this.toDisplayFrame(r, t, ephemeris, mapFrameRotating);
  }

  private displayTime(simTime: number, duration: number): number {
    return simTime + this.sliderT * duration;
  }

  // マップモードの未来ゴーストスライダーが有効な間だけ、環境(太陽・月)表示等に使う
  // 「未来の」simTime を返す。マップを閉じているか、スライダーが 0 のときは現在時刻のまま。
  resolveDisplayTime(mapMode: boolean, player: Player, simTime: number): number {
    if (!mapMode || this.sliderT <= 0) return simTime;
    return this.displayTime(simTime, this.predictDurationSec(player));
  }

  // 未来位置ゴースト(スライダー)のラベル文字列
  ghostLabel(plan: Plan, player: Player, simTime: number): string {
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration);
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
    this.markerManager.hide('ghost');
  }

  // 毎フレーム(マップモード中のみ呼ぶ): 予測を最新化し、折れ線・ゴーストマーカーを更新する。
  update(
    plan: Plan,
    { player, ephemeris, simTime }: { player: Player; ephemeris: EphemerisSystem; simTime: number },
    origin: Vec3,
    mapFrameRotating: boolean,
    project: ProjectFn,
  ): void {
    this.line.setVisible(true);
    this.line.setOrigin(origin);
    plan.maybeRefresh(player, ephemeris, simTime, this.predictDurationSec(player));

    // 予測が再計算された(trajSamples の参照が変わった)フレームでだけ、line.sync()
    // 内部で折れ線のジオメトリが作り直される。表示回転角(trajYawRef)はその
    // タイミングにしか意味を持たないので、同じタイミングでここで固定する。
    this.line.sync(plan.trajSamples, () => {
      this.trajYawRef = mapFrameRotating ? sunAzimuth(simTime, ephemeris.sunPhase0) : 0;
      return {
        nodeTimes: plan.nodes.map((n) => n.time),
        toDisplayFrame: (r: Vec3, t: number) => this.toDisplayFrame(r, t, ephemeris, mapFrameRotating),
      };
    });

    if (this.sliderT <= 0 || plan.trajSamples.length <= 0) {
      this.markerManager.hide('ghost');
      return;
    }
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration);
    const sample = plan.sampleAt(t);
    if (!sample) {
      this.markerManager.hide('ghost');
      return;
    }
    const p = project(sub(this.toDisplayFrame(sample.r, t, ephemeris, mapFrameRotating), origin));
    this.markerManager.set('ghost', 'mk-ghost', '⬡', p.x, p.y, p.front, this.ghostLabel(plan, player, simTime));
  }
}
