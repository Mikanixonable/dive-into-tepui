// 設計図: 先端部の構成を名前付きで保存した値と、その形の検証。ランへ渡す一覧の面もここで宣言する。
import { deserializeShipAssembly, type SerializedShipAssembly } from './ship-assembly-serialization';

// 設計図1件。識別子・名前・作成した実時刻と、先端部を直列化した形を持つ。
// 不変で JSON の素の値だけから成るので、この型をそのまま記録の形に使う(R12)。
export interface ShipBlueprint {
  readonly id: string;
  readonly name: string;
  // 実時刻の unix ミリ秒。
  readonly createdAtReal: number;
  // 起点モジュールから見た先端部の構成。根は1つ。
  readonly piece: SerializedShipAssembly;
}

// value が設計図の形をしていて、先端部がそのまま復元できるか。壊れた値は false。
export function isShipBlueprint(value: unknown): value is ShipBlueprint {
  if (typeof value !== 'object' || value === null) return false;
  const blueprint = value as ShipBlueprint;
  if (typeof blueprint.id !== 'string' || blueprint.id.length === 0) return false;
  if (typeof blueprint.name !== 'string') return false;
  if (!Number.isFinite(blueprint.createdAtReal)) return false;
  try {
    // 接続木の妥当性と根が1つであることは、復元が検証に含める。
    deserializeShipAssembly(blueprint.piece);
  } catch {
    return false;
  }
  return true;
}

// ランへ渡す、設計図一覧の読み取り専用の面。一覧の更新はこの面の実装側が受け持つ。
export interface ShipBlueprintShelf {
  readonly blueprints: readonly ShipBlueprint[];
}
