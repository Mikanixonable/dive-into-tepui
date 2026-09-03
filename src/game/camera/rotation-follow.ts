// カメラの視点の向きを何に固定するかという選択。型・照合キー・セーブ形からの変換と、
// フォーカス対象から選択肢を導く規則を持つ。向きをどう合成するかは持たない —
// 選択に応じて座標系を差し替えるのも、姿勢を掛け合わせるのも FocusCamera の仕事。
import { FrameAnchorSource, FrameRotationSource, rotationSourceKey } from '../../physics/frame';
import type { CelestialMotion } from '../../physics/celestial-motion';
import type { Quat } from '../../math/quat';
import type { FocusTarget } from './focus-target';

// 回転追従の選択(null は慣性系)。選択肢はフォーカス対象から導かれる —
// availableRotationFollows() が唯一の出所。'attitude' はフォーカス機体の姿勢への追従で、
// ReferenceFrame ではなくカメラ内の合成で実現される。
export type CameraRotationFollow = FrameRotationSource | { readonly kind: 'attitude' };

// 選択の同一性の照合キー(選択 UI・妥当性検査が使う)。
export function rotationFollowKey(follow: CameraRotationFollow | null): string {
  if (follow === null) return '';
  return follow.kind === 'attitude' ? 'attitude' : rotationSourceKey(follow);
}

// 選択肢の導出が要求する天体レジストリ。CelestialSystem はこの形を構造的に満たすので、
// 呼び出し側はそのまま渡せる。**CelestialSystem 型そのものを受け取ってはいけない** —
// celestial-system.ts は three/webgpu を import しており、tsconfig.test.json の include へ
// 入ると型検査が DOM 定義を要求して壊れる(focus-target.ts の FocusCandidate と同じ理由)。
export interface CelestialRegistry {
  find(id: string): { readonly motion: CelestialMotion } | null;
  readonly celestialMotions: readonly CelestialMotion[];
}

// セーブ形の回転源。save-data.ts の FrameRotationSourceSaveData と構造的に一致する
// — 型そのものを import しない(save-data.ts は装備・ステージまで型グラフへ引き込む)。
type SavedRotationSource = { readonly kind: 'revolution' | 'spin'; readonly id: string };

// セーブデータの rotatingWith を FrameRotationSource へ変換する。旧セーブは公転対象の id を
// 文字列(または回さないなら null)でそのまま持っていたので、その形は公転として受ける。
export function rotationSourceFromSaveData(
  saved: SavedRotationSource | string | null,
): FrameRotationSource | null {
  if (saved === null) return null;
  if (typeof saved === 'string') return { kind: 'revolution', id: saved };
  return { kind: saved.kind, id: saved.id };
}

// セーブデータの rotatingWith を CameraRotationFollow へ変換する(姿勢追従も受ける)。
export function rotationFollowFromSaveData(
  saved: SavedRotationSource | { readonly kind: 'attitude' } | string | null,
): CameraRotationFollow | null {
  if (saved !== null && typeof saved === 'object' && saved.kind === 'attitude') return { kind: 'attitude' };
  return rotationSourceFromSaveData(saved);
}

// いま選べる回転追従の選択肢(慣性系は常に選べるので含めない)。フォーカスが天体なら
// 自分の公転・子の公転・自分の自転、機体・役割なら(周回中のみ)公転と姿勢。固定点は空。
export function availableRotationFollows(
  focus: FocusTarget,
  celestial: CelestialRegistry,
  frameAnchors: FrameAnchorSource,
  attitudeOf: (id: string, t: number) => Quat | null,
  displayTime: number,
): readonly CameraRotationFollow[] {
  if (focus.kind === 'point') return [];
  const id = focus.id;
  const out: CameraRotationFollow[] = [];
  const body = celestial.find(id);
  if (body !== null) {
    // 天体は、主星を持つなら自分の公転、子を持つならその公転(地球-月回転系で月を静止させる
    // ような組のため)、自転モデルを持つなら自分の自転。
    if (body.motion.primary !== null) out.push({ kind: 'revolution', id });
    for (const motion of celestial.celestialMotions) {
      if (motion.primary?.id === id) out.push({ kind: 'revolution', id: motion.id });
    }
    if (body.motion.spinRotationAt(displayTime) !== null) out.push({ kind: 'spin', id });
  } else {
    // 登録天体でない対象(機体・役割)は、主天体が引けるなら公転、姿勢が引けるなら姿勢。
    if (frameAnchors.attractorOf(id, displayTime) !== null) out.push({ kind: 'revolution', id });
    if (attitudeOf(id, displayTime) !== null) out.push({ kind: 'attitude' });
  }
  return out;
}

// 選択肢のボタンに出す正式名。天体を指す選択は座標系の名前で、機体・役割は対象の名前で書く。
// objectName は id の表示名を返す(SPEC/CAMERA.md 3.1 の「対象の表示名」)。
export function rotationFollowName(
  follow: CameraRotationFollow | null, celestial: CelestialRegistry, objectName: (id: string) => string,
): string {
  if (follow === null) return '慣性系';
  if (follow.kind === 'attitude') return '姿勢追従';
  const name = objectName(follow.id);
  if (follow.kind === 'spin') return `${name}自転座標系`;
  const primary = celestial.find(follow.id)?.motion.primary ?? null;
  return primary !== null ? `${objectName(primary.id)}-${name}回転座標系` : `${name}の公転`;
}

// サマリ行に出す短縮形。正式名から主星と「座標」を落としたもの。
// omitSubject は機体・役割を指す選択から主語も落とす — カメラのサマリは基準欄に同じ名前が
// 並ぶため(SPEC/CAMERA.md 3.1)。
export function rotationFollowShortName(
  follow: CameraRotationFollow | null, celestial: CelestialRegistry,
  objectName: (id: string) => string, omitSubject: boolean,
): string {
  if (follow === null) return '慣性系';
  if (follow.kind === 'attitude') return '姿勢追従';
  // 自転を持つのは登録天体だけなので、自転系は必ず天体名を伴う。
  if (celestial.find(follow.id) !== null) {
    return follow.kind === 'spin' ? `${objectName(follow.id)}自転系` : `${objectName(follow.id)}回転系`;
  }
  return `${omitSubject ? '' : objectName(follow.id)}公転系`;
}
