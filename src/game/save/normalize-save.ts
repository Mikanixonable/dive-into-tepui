// 保存形式の読み込み境界。旧いスナップショットが今の形と食い違うところを、ここで1度だけ揃える。
import { frameRoleAnchorId } from '../../physics/frame';
import type {
  AmmoPickupSaveData, ChaseSaveDataV1, FocusCameraSaveData, GameSaveData,
} from './save-data';

// 参照フレームの役割トークンは保存形へそのまま載る。旧名 @activeShip を今の @controlled へ
// 読み替えないと注視対象が解決できず、戦闘カメラは最後に解決できた位置で固まる。
const OLD_CONTROLLED_ROLE = '@activeShip';

// 旧いスナップショットにしかないキー。読み替えたうえで落とす。
type LegacyKeys = {
  activePlayerId?: string | null;
  ammos?: AmmoPickupSaveData[];
};

// id が旧い役割トークンなら今のトークンへ読み替える。
function swapRole(id: string): string {
  return id === OLD_CONTROLLED_ROLE ? frameRoleAnchorId('controlled') : id;
}

// 回転対象が役割トークンを指していれば読み替える。文字列(公転対象の天体 id)と null は素通し。
function swapRotationSource<T>(source: T): T {
  return typeof source === 'object' && source !== null && 'id' in source
    ? { ...source, id: swapRole((source as { id: string }).id) }
    : source;
}

// 1つのカメラ視点の注視対象と回転対象を読み替える。ChaseSaveDataV1 形は読み捨てられるので触らない。
function swapCameraRoles<T extends FocusCameraSaveData | ChaseSaveDataV1>(camera: T): T {
  if (!('focus' in camera)) return camera;
  const focus = camera.focus.kind === 'object'
    ? { ...camera.focus, id: swapRole(camera.focus.id) }
    : {
      ...camera.focus,
      center: swapRole(camera.focus.center),
      rotatingWith: swapRotationSource(camera.focus.rotatingWith),
    };
  return { ...camera, focus, rotatingWith: swapRotationSource(camera.rotatingWith) };
}

// 保存されたスナップショットを今の形へ揃える。形として読めないものは null を返す。
export function normalizeSaveData(data: GameSaveData): GameSaveData | null {
  const stored = data as GameSaveData & LegacyKeys;
  const ammoPickups = stored.ammoPickups ?? stored.ammos;
  if (!Array.isArray(ammoPickups)) return null;

  const camera = stored.camera;
  const normalized: GameSaveData & Partial<LegacyKeys> = {
    ...stored,
    ammoPickups,
    rcsFuelPickups: stored.rcsFuelPickups ?? [],
    detachedBoosters: stored.detachedBoosters ?? [],
    activeControlledId: stored.activeControlledId ?? stored.activePlayerId ?? null,
    ...(camera === undefined ? {} : {
      camera: {
        ...camera,
        chase: swapCameraRoles(camera.chase),
        overview: swapCameraRoles(camera.overview),
      },
    }),
  };
  delete normalized.ammos;
  delete normalized.activePlayerId;
  return normalized;
}
