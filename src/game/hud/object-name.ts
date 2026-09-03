// HUD が id を画面へ出すときの表示名。役割・機体・天体のどれであっても、この1本で引く。
import { frameRoleOf, FrameRole } from '../../physics/frame';

// 名前を引ける対象。ObjectPickable も DynamicEntity もこの形を構造的に満たす。
export interface NamedObject {
  readonly id: string;
  readonly name: string;
}

// 役割の表示名。
export function frameRoleName(role: FrameRole): string {
  return role === 'activeShip' ? '操作対象の船' : 'ターゲット';
}

// id の表示名。役割名 → candidates の名前 → 天体名 の順に引く。candidates には、そのビューで
// 名前を引ける対象の一覧を優先順に並べて渡す(マップの選択候補、生存中のエンティティなど)。
// 天体名の celestialName は、未登録 id では id をそのまま返してよい。
export function objectName(
  id: string, celestialName: (id: string) => string, ...candidates: readonly (readonly NamedObject[])[]
): string {
  const role = frameRoleOf(id);
  if (role !== null) return frameRoleName(role);
  for (const list of candidates) {
    const found = list.find((item) => item.id === id);
    if (found !== undefined) return found.name;
  }
  return celestialName(id);
}
