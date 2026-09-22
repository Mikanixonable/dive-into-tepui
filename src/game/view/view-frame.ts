// ビュー(戦闘/マップ)固有のフレーム処理と遷移フックのインターフェース。
import type { DisplayWindow } from '../display-window-manager';
import type { CameraFrame } from '../../render/camera/camera-frame';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { PlanEditor } from '../plan/plan-editor';
import type { PerfCounts } from '../perf-counts';

export interface ViewFrame {
  // このビューが直近の update で確定させた被選択物の候補列。候補を持たないビューは空。
  readonly pickables: readonly ObjectPickable[];
  // 同じ回の表示・選択可否。表示トグルを持たないビューは null。
  readonly visibilityPolicy: MapVisibilityPolicy | null;
  // 軌道計画を編集できるビューだけが持つ編集インターフェース。持たないビューは null。
  readonly planEditor: PlanEditor | null;
  // このビューの候補列/ラベル数。
  perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'>;

  // このビューへ入るときの支度。
  onEnter(): void;
  // このビューから出るときの後始末。
  onLeave(): void;
  // ビュー固有の単発入力 commandId を実行する。
  handleCommand(commandId: string): void;
  // 押下中の継続入力をこのビューへ伝達する。
  updateActions(dt: number): void;
  // ポーズ・入力ゲートの判定後に呼ばれる。ポインタ入力の配分。
  handlePointer(camera: CameraFrame): void;
  // update フェーズ: カメラ更新の後。選択候補と可視性ポリシーの確定。
  update(displayWindow: DisplayWindow): void;
  // sync フェーズ前半: 天体ラベル。マーカー同期より先に呼ばれる。nowMs はフレームの実時刻 [ms]。
  syncLabels(displayWindow: DisplayWindow, camera: CameraFrame, nowMs: number): void;
  // sync フェーズ後半: ビュー専用の常設パネル・表示物。軌道線の同期より後に呼ばれる。
  syncPanels(displayWindow: DisplayWindow, camera: CameraFrame, nowMs: number): void;
  // このビューが保持する表示物・DOM を片付ける。
  dispose(): void;
}
