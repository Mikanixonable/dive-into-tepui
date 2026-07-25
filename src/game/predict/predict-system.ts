// 軌道計画(Plan)の「未来表示」を担う薄いオーケストレータ。かつて mapMode に混在していた
// 三責務(camera / plan編集 / 軌道予測)のうちの「軌道予測」に相当する。予測折れ線の描画・
// キャッシュ・表示座標変換・クリック判定は plan 隣接の PlanTrajectory(B-2)へ移り、ここは:
//   ① 表示期間: sliderT / displayTime / resolveDisplayTime と predictDurationKey→秒の解決。
//   ② 予測軌道を描く座標系(frame)の状態保持(HUD トグルが設定、plan-system が B-2 へ渡す)。
//   ③ 未来ゴースト: sliderT に応じた未来時刻の予定 player 位置マーカー(plannedPlayer)の表示。
//      サンプル(sampleAt)と表示座標変換(toDisplay)は B-2 のものを注入で受け取り、Plan も B-2 も
//      import しない。mapMode 中のみ意味を持つ。
import { R_EARTH } from '../../physics/orbital';
import { TrajectorySample } from '../../physics/predict';
import { Vec3, len } from '../../physics/vec3';
import { Frame } from '../../physics/frame';
import * as C from '../const';
import { fmtMarkerDist } from '../hud/utils';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

// 時刻 → 予測サンプルのアクセサ(B-2 の sampleAt を束縛して渡す)。
export type SampleAtFn = (t: number) => TrajectorySample | null;

// ワールド点(時刻 t の r)を表示座標系(太陽回転系対応)へ変換する(B-2 の toDisplay を渡す)。
export type ToDisplayFn = (r: Vec3, t: number) => Vec3;

export class PredictSystem {
  predictDurationKey: PredictDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴーストマーカー非表示)。
  // カメラの視点計算には無関係な、予測表示側の状態のためここが正(MapCamera には置かない)。
  sliderT = 0;
  // 予測軌道を描画する座標系(慣性系 / 太陽回転系)。plan-system が B-2 の描画・ghost へ渡す。
  frame: Frame = 'inertial';

  constructor(private readonly markerManager: MarkerManager) {}

  // 選んだ期間だけ予測する(マップモードでの表示用— 戦闘ビューの噴射ガイド用の
  // 期間は plan-guide.ts の guideDurationSec が別途持つ)。'orbit' キーの周期は呼び出し
  // 側が渡す(orbitPeriod)ため、predictSystem は player.live を読まない。
  predictDurationSec(orbitPeriod: number | null): number {
    if (this.predictDurationKey === 'orbit') {
      if (orbitPeriod !== null && isFinite(orbitPeriod) && orbitPeriod > 0) return orbitPeriod;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  private displayTime(simTime: number, duration: number): number {
    return simTime + this.sliderT * duration;
  }

  // マップモードの未来ゴーストスライダーが有効な間だけ、環境(太陽・月)表示等に使う
  // 「未来の」simTime を返す。マップを閉じているか、スライダーが 0 のときは現在時刻のまま。
  resolveDisplayTime(mapMode: boolean, orbitPeriod: number | null, simTime: number): number {
    if (!mapMode || this.sliderT <= 0) return simTime;
    return this.displayTime(simTime, this.predictDurationSec(orbitPeriod));
  }

  // 予定 player の未来位置(スライダー)のラベル文字列。B-2 の sampleAt を受け、時刻 t の
  // 高度・経過時間を表示する。
  plannedPlayerLabel(sampleAt: SampleAtFn, orbitPeriod: number | null, simTime: number): string {
    const t = this.displayTime(simTime, this.predictDurationSec(orbitPeriod));
    const s = sampleAt(t);
    if (!s) return '';
    const tRel = t - simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  hide(): void {
    this.markerManager.hide('plannedPlayer');
  }

  // 毎フレーム(マップモード中のみ呼ぶ): 未来ゴーストマーカーを B-2 のサンプルから更新する。
  // 折れ線の描画・表示座標変換は B-2(PlanTrajectory)が担うので、ここは未来位置の sampleAt と
  // 表示座標変換 toDisplay を注入で受け取り、マーカーを置くだけ。
  syncGhost(
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
    const t = this.displayTime(simTime, this.predictDurationSec(orbitPeriod));
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
