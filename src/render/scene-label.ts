// 3D 空間の点へ重ねる DOM ラベル(縮尺・天球の方角)の、画面座標への写像と配置。
import type * as THREE from 'three/webgpu';
import { ndcToScreen } from '../math/projection';
import { FONT_SCENE_LABEL, Z_SCENE_LABEL } from '../theme';
import type { Viewport } from './viewport';

// シーンへ重ねる DOM ラベルの共通スタイル。色だけは持ち主が決める。
export const SCENE_LABEL_STYLE = {
  position: 'fixed',
  pointerEvents: 'none',
  zIndex: String(Z_SCENE_LABEL),
  font: FONT_SCENE_LABEL,
  whiteSpace: 'nowrap',
  textShadow: '0 0 4px var(--bg)',
} as const;

// 描画座標の点をカメラで投影し、視錐台の内側なら画面ピクセル座標を返す。外側なら null。
export function projectToScreen(
  p: THREE.Vector3, camera: THREE.Camera, viewport: Viewport,
): { readonly x: number; readonly y: number } | null {
  const v = p.clone().project(camera);
  if (v.z < -1 || v.z > 1) return null;
  return ndcToScreen({ x: v.x, y: v.y, front: true }, viewport.width, viewport.height);
}

// el を点の画面位置へ置いて表示する。縁から margin px 以内へクランプし、y を dy px だけ下げる。
// 視錐台の外なら置かず false を返す。
export function placeScreenLabel(
  el: HTMLElement, p: THREE.Vector3, camera: THREE.Camera, viewport: Viewport,
  margin: number, dy = 0,
): boolean {
  const s = projectToScreen(p, camera, viewport);
  if (s === null) return false;
  el.style.left = `${Math.max(margin, Math.min(viewport.width - margin, s.x))}px`;
  el.style.top = `${Math.max(margin, Math.min(viewport.height - margin, s.y + dy))}px`;
  el.style.display = '';
  return true;
}
