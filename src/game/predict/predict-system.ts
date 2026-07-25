// 軌道計画(Plan)の「未来表示」を担う薄いオーケストレータ。mapMode の三責務
// (camera / plan編集 / 軌道予測)のうちの「軌道予測」に相当する。予測折れ線の描画・
// キャッシュ・表示座標変換・クリック判定は editor 所有の PlanTrajectory(B-2)が担い、ここは:
//   ① 表示期間: sliderT / displayTime / resolveDisplayTime と durationKey→秒の解決。
//   ② 予測軌道を描く表示座標系 trajectoryFrame。カメラを固定する座標系(MapCamera.cameraFrame)
//      とは独立で、「軌道の形をどの座標系で見るか」と「視点をどの座標系に固定するか」を別々に選べる。
//   ③ 未来ゴースト: sliderT に応じた未来時刻の予定 player 位置マーカー(plannedPlayer)の表示。
//      サンプル(sampleAt)と表示座標変換(toDisplay)は B-2 のものを注入で受け取り、Plan も B-2 も
//      import しない。mapMode 中のみ意味を持つ。
//   ④ 操作パネル(PredictPanel)の所有。映すのも受けるのも上記 ①〜③ の predict 自身の状態だけ。
import { OrbitState, R_EARTH } from '../../physics/orbital';
import { Vec3, len } from '../../physics/vec3';
import { Frame } from '../../physics/frame';
import * as C from '../const';
import { fmtMarkerDist } from '../hud/utils';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';
import { PredictPanel } from './predict-panel';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

// 時刻 → 予測サンプルのアクセサ(B-2 の sampleAt を束縛して渡す)。
export type SampleAtFn = (t: number) => OrbitState | null;

// ワールド点(時刻 t の r)を表示座標系(太陽回転系対応)へ変換する(B-2 の toDisplay を渡す)。
export type ToDisplayFn = (r: Vec3, t: number) => Vec3;

export class PredictSystem {
  durationKey: PredictDurationKey = 'day';
  // 予測折れ線を描く表示座標系。PlanTrajectory はこれを毎フレーム受け取って bake/un-bake する。
  trajectoryFrame: Frame = 'inertial';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴーストマーカー非表示)。
  // カメラの視点計算には無関係な、予測表示側の状態のためここが正(MapCamera には置かない)。
  sliderT = 0;
  // 表示期間が変わったときの通知。予測キャッシュをその場で引き直す(スロットル待ちを挟まない)
  // ために game が PlanTrajectory へ配線する。
  onDurationChange: (() => void) | null = null;

  private readonly panel: PredictPanel;

  constructor(hudRoot: HTMLElement, private readonly markerManager: MarkerManager) {
    this.panel = new PredictPanel(hudRoot);
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
      this.onDurationChange?.();
    };
    this.panel.onFrameSelect = (frame) => {
      this.trajectoryFrame = frame;
    };
    this.panel.onSliderChange = (t) => {
      this.sliderT = t;
    };
  }

  // 選んだ期間だけ予測する(マップモードでの表示用— 戦闘ビューの噴射ガイド用の
  // 期間は plan-guide.ts の guideDurationSec が別途持つ)。'orbit' キーの周期は呼び出し
  // 側が渡す(orbitPeriod)ため、predictSystem は player.live を読まない。
  durationSec(orbitPeriod: number | null): number {
    if (this.durationKey === 'orbit') {
      if (orbitPeriod !== null && isFinite(orbitPeriod) && orbitPeriod > 0) return orbitPeriod;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.durationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.durationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  private displayTime(simTime: number, duration: number): number {
    return simTime + this.sliderT * duration;
  }

  // マップモードの未来ゴーストスライダーが有効な間だけ、環境(太陽・月)表示やマップラベルに使う
  // 「未来の」simTime を返す。マップを閉じているか、スライダーが原点にあるときは現在時刻のまま。
  resolveDisplayTime(mapMode: boolean, orbitPeriod: number | null, simTime: number): number {
    if (!mapMode || this.sliderT <= 0) return simTime;
    return this.displayTime(simTime, this.durationSec(orbitPeriod));
  }

  // 予定 player の未来位置(スライダー)のラベル文字列。B-2 の sampleAt を受け、時刻 t の
  // 高度・経過時間を表示する。
  plannedPlayerLabel(sampleAt: SampleAtFn, orbitPeriod: number | null, simTime: number): string {
    const t = this.displayTime(simTime, this.durationSec(orbitPeriod));
    const s = sampleAt(t);
    if (!s) return '';
    const tRel = t - simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  // 毎フレーム(マップモード中のみ呼ぶ): 未来ゴーストマーカーと操作パネルを更新する。
  // 折れ線の描画・表示座標変換は B-2(PlanTrajectory)が担うので、ここは未来位置の sampleAt と
  // 表示座標変換 toDisplay を注入で受け取り、マーカーを置くだけ。
  sync(
    sampleAt: SampleAtFn,
    toDisplay: ToDisplayFn,
    orbitPeriod: number | null,
    simTime: number,
    project: ProjectFn,
  ): void {
    this.syncGhost(sampleAt, toDisplay, orbitPeriod, simTime, project);
    this.panel.setVisible(true);
    this.panel.setDuration(this.durationKey);
    this.panel.setFrame(this.trajectoryFrame);
    this.panel.setSliderLabel(
      this.sliderT > 0 ? this.plannedPlayerLabel(sampleAt, orbitPeriod, simTime) : null,
    );
  }

  // マップモード外の後始末: ゴーストマーカーと操作パネルを隠す。
  hide(): void {
    this.markerManager.hide('plannedPlayer');
    this.panel.setVisible(false);
  }

  private syncGhost(
    sampleAt: SampleAtFn,
    toDisplay: ToDisplayFn,
    orbitPeriod: number | null,
    simTime: number,
    project: ProjectFn,
  ): void {
    if (this.sliderT <= 0) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    const t = this.displayTime(simTime, this.durationSec(orbitPeriod));
    const sample = sampleAt(t);
    if (!sample) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer',
      'mk-planned',
      '⬡',
      toDisplay(sample.r, t),
      project,
      this.plannedPlayerLabel(sampleAt, orbitPeriod, simTime),
    );
  }
}
