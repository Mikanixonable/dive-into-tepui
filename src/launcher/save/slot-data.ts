// スロットとスナップショットの索引の形。一覧 UI と入出力がここだけを読んで済むように、
// ランの直列化形(GameSaveData)からは切り離して持つ。
import type { GamePhase } from '../../game/stages/stage';
import type { GameSaveData } from '../../game/save/save-data';

// スナップショットの由来。撮られ方であって、保持されるかどうか(SnapshotMeta.pinned)とは
// 別の軸。クリップは pinned を立てるだけで kind は書き換えない — 由来を塗り替えると
// どのトリガで撮られたかが失われる。
export type SnapshotKind = 'auto' | 'manual' | 'checkpoint';

// 一覧 UI がスナップショット本体を読まずに1件を描くための情報。すべて GameSaveData から
// 導出でき、正本ではなく索引。
export interface SnapshotMeta {
  id: string;
  kind: SnapshotKind;
  pinned: boolean;
  name: string;
  createdAtReal: number;
  simTime: number;
  centerBodyId: string;
  altitude: number;
  speed: number;
  hpRatio: number;
  maxHp: number;
  magazines: number;
  money: number;
  playerCount: number;
  enemyAliveCount: number;
  phase: GamePhase;
}

// 1ステージぶんのスナップショット集合とクリア記録。スロットは遊んだステージごとに1件持つ。
export interface StageHistoryMeta {
  stageId: string;
  clearCount: number;
  lastPlayedAtReal: number;
  // 新しい順。
  snapshots: SnapshotMeta[];
}

// セーブデータ(歴史線)1件。
export interface SaveSlotMeta {
  id: string;
  name: string;
  createdAtReal: number;
  lastPlayedAtReal: number;
  lastStageId: string;
  stages: StageHistoryMeta[];
}

// 全スロットのメタを束ねた索引。スナップショット本体は別キーに置き、一覧描画で
// 本体を読まずに済むようにする。
export interface SaveIndex {
  version: number;
  slots: SaveSlotMeta[];
  activeSlotId: string | null;
}

// 書き出しファイルの識別子と形式バージョン。組み立てる側(SaveSlots)と検証する側
// (save-transfer)の両方が参照するので、どちらでもない型定義の場所に置く。
export const SLOT_EXPORT_FORMAT = 'tepui.slot';
export const SLOT_EXPORT_VERSION = 1;

// スロット1件を書き出したファイルの中身。format は無関係な JSON を読ませたときに
// 「壊れたセーブ」ではなく「セーブファイルではない」と判定するための識別子。
export interface SlotExport {
  format: typeof SLOT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAtReal: number;
  slot: SaveSlotMeta;
  // スナップショット id → 本体。
  snapshots: Record<string, GameSaveData>;
}
