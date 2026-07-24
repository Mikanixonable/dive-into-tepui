// 軌道計画(Plan)の「将来の軌道予測・未来状態表示」を担う独立責務。かつて mapMode に
// 混在していた三責務(camera / plan編集 / 軌道予測)のうちの「軌道予測」に相当する。
// この責務は二つに分かれる:
//   ① 計算(compute): plan の frozen アンカー + 凍結ノードから未来の予定 player 位置を
//      数値予測する。ステートレスかつ player.live 非依存(現在時刻というスカラは読むが
//      自機の状態は読まない)。キャッシュは所有せず、結果を貯めるのは Plan(隣接)側。
//   ② 未来表示: sliderT に応じた未来時刻の管理(displayTime/resolveDisplayTime)と、
//      予測折れ線(TrajLine)・予定 player マーカー(plannedPlayer)の描画。
// 表示(syncDisplay)は Plan の隣接キャッシュを引数で受け取り、Plan を import しない。
//
// 「太陽回転系」表示の座標変換(toDisplayFrame)もここが正 — 予測の再計算(TrajLine の
// ジオメトリ再構築)と同じタイミングで回転基準角(trajYawRef)を固定する必要があるため、
// plan-editor.ts のクリックピッキングも DisplayFrameFn 経由でここに委譲する(二重に基準角を
// 持つとずれる)。mapMode 中のみ意味を持つ。
import * as THREE from 'three/webgpu';
import { OrbitState, R_EARTH } from '../../physics/orbital';
import { sunAzimuth } from '../../physics/ephemeris';
import { PlannedNode, PredictOpts, TrajectorySample, predictTrajectory, sampleAt } from '../../physics/predict';
import { Vec3, len, rotateAxis, v3 } from '../../physics/vec3';
import * as C from '../const';
import { fmtMarkerDist } from '../hud/utils';
import { TrajLine } from './trajline';
import { MarkerManager } from '../marker/marker-manager';
import { ProjectFn } from '../camera/camera-system';
import type { Player } from '../player/player';
import type { EphemerisSystem } from '../ephemeris';
import { FloatingOrigin } from '../floating-origin';

export type PredictDurationKey = 'orbit' | 'day' | 'week' | 'month';

// plan-editor.ts のクリック判定・ドラッグへ渡す、太陽回転系表示込みの座標変換。
// PredictSystem.toDisplayFrame を ephemeris/frameRotating で束縛したクロージャを
// 型として共有する。
export type DisplayFrameFn = (r: Vec3, t: number) => Vec3;

export class PredictSystem {
  readonly line = new TrajLine();
  predictDurationKey: PredictDurationKey = 'day';
  // マップモードの未来ゴーストスライダー位置(0..1、0 でゴーストマーカー非表示)。
  // カメラの視点計算には無関係な、予測表示側の状態のためここが正(MapCamera には置かない)。
  sliderT = 0;

  // 直近の折れ線再構築(line.sync() が予測更新を検出したタイミング)で固定した
  // 表示回転角。同じ trajSamples を指している間はクリック判定(plan-editor.ts)・
  // 描画とも同じ値を使う。
  private trajYawRef = 0;

  constructor(private readonly markerManager: MarkerManager, scene: THREE.Scene) {
    scene.add(this.line.group);
  }

  // frozen アンカー起点 + 凍結ノードから未来の予定 player 位置を数値予測する
  // (ステートレス、player.live 非依存)。アンカーは過去でありうるので、「アンカー →
  // 現在 nowTime + 表示期間」の全長を積分する(nowTime はスカラの時計であって
  // player の状態ではない)。結果は Plan の隣接キャッシュへ呼び出し側が貯める。
  compute(
    anchor: { time: number; state: OrbitState },
    ephemeris: EphemerisSystem,
    nowTime: number,
    nodes: readonly PlannedNode[],
    displayDuration: number,
  ): TrajectorySample[] {
    const span = nowTime + displayDuration - anchor.time;
    if (span <= 0) return [];
    const opts: PredictOpts = {
      sunPhase0: ephemeris.sunPhase0,
      moonPhase0: ephemeris.moonPhase0,
      maxSamples: C.PREDICT_MAX_SAMPLES,
    };
    return predictTrajectory(anchor.state, anchor.time, span, nodes, opts);
  }

  // 選んだ期間だけ予測する(マップモードでの表示用— 戦闘ビューの噴射ガイド用の
  // 期間は plan-guide.ts の guideDurationSec が別途持つ)。
  predictDurationSec(player: Player): number {
    if (this.predictDurationKey === 'orbit') {
      const el = player.elements;
      if (el && isFinite(el.period) && el.period > 0) return el.period;
      return C.PREDICT_DUR_DAY; // 双曲線・放物線軌道では1日にフォールバック
    }
    if (this.predictDurationKey === 'week') return C.PREDICT_DUR_WEEK;
    if (this.predictDurationKey === 'month') return C.PREDICT_DUR_MONTH;
    return C.PREDICT_DUR_DAY;
  }

  // ECI 座標 r(時刻 t のもの)をマップの「太陽回転系」表示用に回転させる
  // (非回転系なら無変換)。
  private toDisplayFrame(r: Vec3, t: number, ephemeris: EphemerisSystem, frameRotating: boolean): Vec3 {
    if (!frameRotating) return r;
    const phi = this.trajYawRef - sunAzimuth(t, ephemeris.sunPhase0);
    return rotateAxis(r, v3(0, 1, 0), phi);
  }

  // 太陽回転系表示込みの座標変換を束縛したクロージャを返す。plan-editor.ts のクリック
  // 判定・ドラッグ・ギズモ配置は必ずこの1つの変換を通すことで、描画とずれないようにする。
  bindDisplayFrame(ephemeris: EphemerisSystem, frameRotating: boolean): DisplayFrameFn {
    return (r: Vec3, t: number) => this.toDisplayFrame(r, t, ephemeris, frameRotating);
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

  // 予定 player の未来位置(スライダー)のラベル文字列。予測サンプル列(Plan の隣接
  // キャッシュ)を引数で受け、時刻 t の高度・経過時間を表示する。
  plannedPlayerLabel(cache: readonly TrajectorySample[], player: Player, simTime: number): string {
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration);
    const s = sampleAt(cache, t);
    if (!s) return '';
    const tRel = t - simTime;
    const alt = len(s.r) - R_EARTH;
    const h = Math.floor(tRel / 3600);
    const m = Math.floor((tRel % 3600) / 60);
    return `T+${h}h${String(m).padStart(2, '0')}m 高度 ${fmtMarkerDist(alt, 0)}`;
  }

  hide(): void {
    this.line.setVisible(false);
    this.markerManager.hide('plannedPlayer');
  }

  // 毎フレーム(マップモード中のみ呼ぶ): Plan の隣接キャッシュ(cache)から折れ線・
  // ゴーストマーカーを更新する。予測の再計算・保存は呼び出し側(plan-system.ts の
  // 更新トリガ)が済ませており、ここは表示のみ — Plan を import しない。
  syncDisplay(
    cache: readonly TrajectorySample[],
    nodeTimes: readonly number[],
    player: Player,
    ephemeris: EphemerisSystem,
    simTime: number,
    fo: FloatingOrigin,
    frameRotating: boolean,
    project: ProjectFn,
  ): void {
    this.line.setVisible(true);
    this.line.setOrigin(fo);

    // 予測が再計算された(cache の参照が変わった)フレームでだけ、line.sync() 内部で
    // 折れ線のジオメトリが作り直される。表示回転角(trajYawRef)はそのタイミングにしか
    // 意味を持たないので、同じタイミングでここで固定する。
    this.line.sync(cache, () => {
      this.trajYawRef = frameRotating ? sunAzimuth(simTime, ephemeris.sunPhase0) : 0;
      return {
        nodeTimes,
        toDisplayFrame: (r: Vec3, t: number) => this.toDisplayFrame(r, t, ephemeris, frameRotating),
      };
    });

    if (this.sliderT <= 0 || cache.length <= 0) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    const duration = this.predictDurationSec(player);
    const t = this.displayTime(simTime, duration);
    const sample = sampleAt(cache, t);
    if (!sample) {
      this.markerManager.hide('plannedPlayer');
      return;
    }
    this.markerManager.setPosition(
      'plannedPlayer',
      'mk-planned',
      '⬡',
      this.toDisplayFrame(sample.r, t, ephemeris, frameRotating),
      project,
      this.plannedPlayerLabel(cache, player, simTime),
    );
  }
}
