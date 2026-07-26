// 軌道計画(Plan)の「未来表示」を担うオーケストレータ。mapMode の三責務
// (camera / plan編集 / 軌道予測)のうちの「軌道予測」に相当する。担うのは:
//   ① 表示期間: sliderT / displayTime / resolveDisplayTime と durationKey→秒の解決。
//   ② 予測軌道を描く表示座標系 trajectoryFrame。カメラを固定する座標系(OverviewCamera.cameraFrame)
//      とは独立で、「軌道の形をどの座標系で見るか」と「視点をどの座標系に固定するか」を別々に選べる。
//   ③ 予測折れ線 PlanTrajectory(B-2)の所有と駆動。①②はどちらもこれへ流し込む値なので、
//      予測キャッシュ・表示座標変換・画面判定を持つ B-2 はここが持つのが自然。編集側
//      (PlanEditor)へは B-2 のインスタンスを参照共有し、画面判定だけを使わせる。
//   ④ 未来ゴースト: sliderT に応じた未来時刻の予定 player 位置マーカー(plannedPlayer)の表示。
//   ⑤ 操作パネル(PredictPanel)の所有。映すのも受けるのも上記 ①〜④ の predict 自身の状態だけ。
import * as THREE from 'three/webgpu';
import { R_EARTH } from '../../physics/orbital';
import { len } from '../../physics/vec3';
import { Frame } from '../../physics/frame';
import type { Ephemeris } from '../../physics/ephemeris';
import * as C from '../const';
import { fmtMarkerDist } from '../hud/utils';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';
import { FloatingOrigin } from '../floating-origin';
import { Plan } from '../plan/plan';
import { PlanTrajectory } from './plan-trajectory';
import { PredictPanel } from './predict-panel';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

export class PredictSystem {
  // 未来表示を禁止するフラグ。マップモードの正本(MapModeToggler.mapMode)が切り替える
  // 影響先の一つで、視点や編集モードとは独立した責務(初期値 = 戦闘ビューなので禁止)。
  private _forceCurrent = true;
  get forceCurrent(): boolean {
    return this._forceCurrent;
  }
  set forceCurrent(v: boolean) {
    this._forceCurrent = v;
    /*
    if (v) {
      // 強制的に未来表示を禁止するべきだ。
      this.sliderT = 0;
      // panelのスライダーも強制的に0にする。いまは配線がないから保留。
    }
    */
  }

  durationKey: PredictDurationKey = 'day';
  // 予測折れ線を描く表示座標系。毎フレーム PlanTrajectory へ渡して bake/un-bake させる。
  trajectoryFrame: Frame = 'inertial';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴーストマーカー非表示)。
  // カメラの視点計算には無関係な、予測表示側の状態のためここが正(OverviewCamera には置かない)。
  sliderT = 0;

  // 多ノード予測折れ線 + per-arc キャッシュ(B-2)。編集側の PlanEditor は画面判定
  // (projectPoint / nearestSample)のためにこの参照を共有する。
  readonly traj: PlanTrajectory;

  private readonly panel: PredictPanel;

  constructor(
    hudRoot: HTMLElement,
    private readonly markerManager: MarkerManager,
    private readonly ephemeris: Ephemeris,
    scene: THREE.Scene,
  ) {
    this.traj = new PlanTrajectory(scene);
    this.panel = new PredictPanel(hudRoot);
    this.panel.onDurationSelect = (key) => {
      this.durationKey = key;
      // 表示期間が変わった瞬間に引き直す(窓の滑りと区別できないのでスロットル待ちを挟まない)。
      this.traj.invalidate();
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
  resolveDisplayTime(orbitPeriod: number | null, simTime: number): number {
    if (this.forceCurrent || this.sliderT <= 0) return simTime;
    return this.displayTime(simTime, this.durationSec(orbitPeriod));
  }

  // 毎フレーム呼ぶ。マップモード中(未来表示が許される間)は予測折れ線・未来ゴーストマーカー・
  // 操作パネルを駆動し、それ以外では後始末する。予測は plan の corners(frozen アンカー +
  // 凍結ノード)だけの純関数で、player.live には依存しない。
  sync(plan: Plan, orbitPeriod: number | null, simTime: number, fo: FloatingOrigin, project: ProjectFn): void {
    if (this.forceCurrent) {
      this.hide();
      return;
    }
    const duration = this.durationSec(orbitPeriod);
    this.traj.setVisible(true);
    this.traj.update(plan, simTime + duration, this.ephemeris, this.trajectoryFrame, simTime, fo, project);
    this.syncGhost(duration, simTime, project);
    this.panel.setVisible(true);
    this.panel.setDuration(this.durationKey);
    this.panel.setFrame(this.trajectoryFrame);
    this.panel.setSliderLabel(this.sliderT > 0 ? this.plannedPlayerLabel(duration, simTime) : null);
  }

  // マップモード外の後始末: 予測折れ線・ゴーストマーカー・操作パネルを隠す。
  hide(): void {
    this.traj.setVisible(false);
    this.markerManager.hide('plannedPlayer');
    this.panel.setVisible(false);
  }

  private syncGhost(duration: number, simTime: number, project: ProjectFn): void {
    if (this.sliderT <= 0) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    const t = this.displayTime(simTime, duration);
    const sample = this.traj.sampleAt(t);
    if (!sample) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer',
      'mk-planned',
      '⬡',
      this.traj.toDisplay(sample.r, t),
      project,
      this.plannedPlayerLabel(duration, simTime),
    );
  }

  // 予定 player の未来位置(スライダー)のラベル文字列。時刻 t の高度・経過時間を表示する。
  private plannedPlayerLabel(duration: number, simTime: number): string {
    const t = this.displayTime(simTime, duration);
    const s = this.traj.sampleAt(t);
    if (!s) return '';
    const tRel = t - simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }
}
