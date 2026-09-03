// ビュー(戦闘/マップ)固有の処理の口。フレーム処理は update/sync の固定位置で現在のビューの
// 実装だけが呼ばれ、遷移フックは setView() の中で呼ばれる。
import type { DisplayWindow } from '../display-window-manager';
import type { FloatingOrigin } from '../camera/floating-origin';
import type { Input } from '../../input/input';
import type { ObjectPickable } from '../pickable/object-pickable';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { PerfCounts } from '../../perf-meter';

export type View = 'combat' | 'map';

export interface ViewFrame {
  // このビューが直近の update で確定させた被選択物の候補列。候補を持たないビューは空。
  readonly pickables: readonly ObjectPickable[];
  // 同じ回の表示・選択可否。表示トグルを持たないビューは null。
  readonly visibilityPolicy: MapVisibilityPolicy | null;
  // 負荷確認ウィンドウが読む、このビューの候補列/ラベル数。
  perfCounts(): Pick<PerfCounts, 'mapMode' | 'mapItems' | 'mapLabels'>;

  // このビューへ遷移できるか。
  canEnter(): boolean;
  // このビューへ入るときの支度。
  onEnter(): void;
  // このビューから出るときの後始末。
  onLeave(): void;
  // ビュー固有のキー入力の配分。ポーズ中・決着後も効くべき操作を持つ。
  handleInput(input: Input, dt: number, simTime: number): void;
  // ポーズ・入力ゲートの判定後に呼ばれる。ポインタ入力の配分。
  handlePointer(simTime: number): void;
  // update フェーズ: カメラ更新の後。選択候補と可視性ポリシーの確定。
  update(displayWindow: DisplayWindow): void;
  // sync フェーズ前半: 天体ラベル。マーカー同期が近接判定に読むため、その前に呼ばれる。
  syncLabels(): void;
  // sync フェーズ後半: ビュー専用の常設パネル・表示物。軌道線の同期より後に呼ばれる。
  syncPanels(displayWindow: DisplayWindow, fo: FloatingOrigin): void;
  // このビューが保持する表示物・DOM を片付ける。
  dispose(): void;
}
