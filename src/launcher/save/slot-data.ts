// セーブの索引(スロット・ステージ履歴・手動セーブのメタ)と、書き出しファイルの形。
import type { GamePhase } from '../../game/stages/stage';
import type { SavedGame } from './save-store';

// 索引が指す id を1つ作る。同一ミリ秒内に続けて作っても衝突しない。
export function newSaveId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// 一覧 UI が本体を読まずに手動セーブ1件を描くための情報。すべて SerializedGame から
// 導出でき、正本ではなく索引。
export interface SnapshotMeta {
  id: string;
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

// 1ステージぶんの記録とクリア記録。スロットは遊んだステージごとに1件持つ。
export interface StageHistoryMeta {
  stageId: string;
  clearCount: number;
  lastPlayedAtReal: number;
  // 手動セーブ。新しい順。
  snapshots: SnapshotMeta[];
  // 自動セーブの本体を指す id(手動セーブとは別枠)。無ければ null。
  autoSaveId: string | null;
}

// セーブデータ(歴史線)1件。
export interface SaveSlotMeta {
  id: string;
  name: string;
  createdAtReal: number;
  lastPlayedAtReal: number;
  // 直近に遊んだ周回。一度も遊んでいないスロットでは null。ended は決着したか、
  // タイトルへ戻ったかで、どちらもその周回はもう再開しない。
  lastRun: { readonly stageId: string; readonly ended: boolean } | null;
  stages: StageHistoryMeta[];
}

// 全スロットのメタを束ねた索引。記録本体は id で指し、索引とは別に置く。
export interface SaveIndex {
  version: number;
  slots: SaveSlotMeta[];
  activeSlotId: string | null;
}

// 書き出しファイルの識別子と形式バージョン。
export const SLOT_EXPORT_FORMAT = 'tepui.slot';
export const SLOT_EXPORT_VERSION = 2;

// スロット1件を書き出したファイルの中身。format は無関係な JSON を読ませたときに
// 「壊れたセーブ」ではなく「セーブファイルではない」と判定するための識別子。
export interface SlotExport {
  format: typeof SLOT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAtReal: number;
  slot: SaveSlotMeta;
  // スナップショット id → 本体。
  snapshots: Record<string, SavedGame>;
}
