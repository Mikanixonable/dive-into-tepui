// 機体の設計データ(§4-1)。形状ツリー・搭載要素の配置・流路・塗装・段の分離順を1つの値にまとめた
// もので、これを保存し、検証し、生産にかける。DOM にも THREE にも依存しない。

import type { PartPlacement, VesselAssembly } from './assembly';
import type { VesselTree } from './tree';
import type { FeedNetwork } from './feed-network';
import { EMPTY_FEED_NETWORK } from './feed-network';

// 設計データの版。読み替えられない版のデータは拒否する。
export const BLUEPRINT_VERSION = 1;

// 書き出したファイルの識別子。無関係な JSON を「設計ファイルではない」と言い分けるためにある。
export const BLUEPRINT_FILE_FORMAT = 'tepui-blueprint';

// ファイル形式そのものの版。設計データの版とは別に上がる。
export const BLUEPRINT_FILE_VERSION = 1;

export interface PaintScheme {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  metalness: number;
  roughness: number;
}

export interface VesselBlueprint {
  readonly id: string;
  name: string;
  readonly tree: VesselTree;
  readonly placements: readonly PartPlacement[];
  readonly feedNetwork: FeedNetwork; // 配管の敷設(§10)
  readonly paint: PaintScheme;
  // 分離機構のエッジ id を、切り離す順に並べたもの。
  readonly stageOrder: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// 設計をそのまま組み立てとして読む。質量特性・内容積の割り当てはこの形を取る。
export function assemblyOf(bp: VesselBlueprint): VesselAssembly {
  return { tree: bp.tree, placements: bp.placements };
}

export const DEFAULT_PAINT: PaintScheme = {
  primaryColor: '#d8dce2',
  secondaryColor: '#3a4048',
  accentColor: '#ff6a00',
  metalness: 0.6,
  roughness: 0.45,
};

// 設計1つを組む。id と時刻は呼び出し側が決める — 保存の層が採番と時計を持ち、この関数は持たない。
export interface BlueprintDraft {
  readonly id: string;
  readonly name: string;
  readonly tree: VesselTree;
  readonly placements: readonly PartPlacement[];
  readonly feedNetwork?: FeedNetwork;
  readonly paint?: PaintScheme;
  readonly stageOrder?: readonly string[];
  readonly now: number;
}

export function createBlueprint(draft: BlueprintDraft): VesselBlueprint {
  return {
    id: draft.id,
    name: draft.name,
    tree: draft.tree,
    placements: draft.placements,
    feedNetwork: draft.feedNetwork ?? EMPTY_FEED_NETWORK,
    paint: draft.paint ?? DEFAULT_PAINT,
    stageOrder: draft.stageOrder ?? [],
    createdAt: draft.now,
    updatedAt: draft.now,
  };
}

// 元の設計には触れず、新しい id を持つ複製を返す。作成時刻も複製した時点になる — 複製は
// 元の履歴を引き継がない別の設計であって、同じ設計の別名ではない。
export function duplicateBlueprint(bp: VesselBlueprint, id: string, name: string, now: number): VesselBlueprint {
  return { ...bp, id, name, createdAt: now, updatedAt: now };
}

export function renameBlueprint(bp: VesselBlueprint, name: string, now: number): VesselBlueprint {
  return { ...bp, name, updatedAt: now };
}

// ---------------------------------------------------------------------------
// ファイルの形
// ---------------------------------------------------------------------------

// 書き出す設計1件と、それが従う設計データの版。
export interface BlueprintFileEntry {
  readonly version: number;
  readonly blueprint: VesselBlueprint;
}

export interface BlueprintFile {
  readonly format: typeof BLUEPRINT_FILE_FORMAT;
  readonly formatVersion: number;
  readonly exportedAtReal: number;
  readonly blueprints: readonly BlueprintFileEntry[];
}

export function buildBlueprintFile(blueprints: readonly VesselBlueprint[], now: number): BlueprintFile {
  return {
    format: BLUEPRINT_FILE_FORMAT,
    formatVersion: BLUEPRINT_FILE_VERSION,
    exportedAtReal: now,
    blueprints: blueprints.map((blueprint) => ({ version: BLUEPRINT_VERSION, blueprint })),
  };
}

export type BlueprintParseResult =
  | { readonly ok: true; readonly blueprints: readonly VesselBlueprint[] }
  | { readonly ok: false; readonly reason: string };

// unknown から段階的に BlueprintFile の形を確かめる。識別子が合わないものは「設計ファイルではない」、
// 識別子は合うが構造が壊れているものは「壊れている」と、理由を言い分ける — 前者は読み込む対象を
// 取り違えただけであり、後者は取り違えていない設計ファイルが壊れている。
export function parseBlueprintFile(parsed: unknown): BlueprintParseResult {
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'これは Dive into Tepui の設計ファイルではありません' };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== BLUEPRINT_FILE_FORMAT) {
    return { ok: false, reason: 'これは Dive into Tepui の設計ファイルではありません' };
  }

  const formatVersion = obj.formatVersion;
  if (typeof formatVersion !== 'number' || formatVersion < 1 || formatVersion > BLUEPRINT_FILE_VERSION) {
    return { ok: false, reason: `対応していない形式のバージョンです (v${String(formatVersion)})` };
  }
  if (!Array.isArray(obj.blueprints)) {
    return { ok: false, reason: '設計ファイルが壊れています' };
  }

  const blueprints: VesselBlueprint[] = [];
  for (const entry of obj.blueprints as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: '設計ファイルが壊れています' };
    const record = entry as Record<string, unknown>;
    if (record.version !== BLUEPRINT_VERSION) {
      return { ok: false, reason: `対応していない設計データのバージョンです (v${String(record.version)})` };
    }
    const blueprint = checkBlueprintShape(record.blueprint);
    if (blueprint === null) return { ok: false, reason: '設計ファイルが壊れています' };
    blueprints.push(blueprint);
  }
  if (blueprints.length === 0) return { ok: false, reason: '設計が1つも入っていません' };
  return { ok: true, blueprints };
}

// 設計1件の骨格を確かめる。中身の整合(形状として成り立つか)は validateBlueprint が見るので、
// ここで確かめるのは「この形として読めるか」だけに留める。
export function checkBlueprintShape(value: unknown): VesselBlueprint | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const tree = obj.tree as Record<string, unknown> | undefined;
  if (
    typeof obj.id !== 'string' || obj.id === '' ||
    typeof obj.name !== 'string' ||
    typeof tree !== 'object' || tree === null ||
    !Array.isArray(tree.nodes) || !Array.isArray(tree.edges) ||
    !Array.isArray(obj.placements) ||
    !Array.isArray(obj.stageOrder) ||
    typeof obj.createdAt !== 'number' || typeof obj.updatedAt !== 'number'
  ) {
    return null;
  }
  const feedNetwork = obj.feedNetwork as Record<string, unknown> | undefined;
  if (feedNetwork !== undefined && (typeof feedNetwork !== 'object' || feedNetwork === null || !Array.isArray(feedNetwork.routes))) {
    return null;
  }
  const paint = obj.paint as PaintScheme | undefined;
  const bp = obj as unknown as VesselBlueprint;
  return {
    ...bp,
    feedNetwork: feedNetwork === undefined ? EMPTY_FEED_NETWORK : (feedNetwork as unknown as FeedNetwork),
    paint: paint === undefined ? DEFAULT_PAINT : paint,
  };
}
