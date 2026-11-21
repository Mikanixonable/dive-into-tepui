// 座標系パネルの図案アイコン・リアルタイム座標系ミニ図式・角度コンパスの SVG 生成。
// 色はすべて CSS 変数(var(--...))で指定し、どのテーマでも配色へ自動追従させる。
import type { CelestialClass } from '../../celestial/celestial-entity/celestial-entity-def';
import type { CameraReferencePlane, CameraReferenceView, CameraRotationFollow } from '../../viewer/focus-camera-selection';

// 中心タイルのアイコン種別。
export type CenterGlyphKind = 'ship' | 'target' | 'star' | 'planet' | 'moon' | 'lagrange' | 'free';

// 中心タイル用のミニ SVG(20x20)。
export function centerGlyphSvg(kind: CenterGlyphKind): string {
  switch (kind) {
    case 'ship':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polygon points="10,3 15,16 10,13 5,16"/></svg>';
    case 'target':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="5"/><path d="M10 2.5v3M10 14.5v3M2.5 10h3M14.5 10h3"/></svg>';
    case 'star':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="3.8" fill="currentColor" fill-opacity="0.3"/><path d="M10 2.5v2.4M10 15.1v2.4M2.5 10h2.4M15.1 10h2.4M4.7 4.7l1.7 1.7M13.6 13.6l1.7 1.7M15.3 4.7l-1.7 1.7M6.4 13.6l-1.7 1.7"/></svg>';
    case 'planet':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="5.6"/><ellipse cx="10" cy="10" rx="5.6" ry="2.1" stroke-opacity="0.6"/></svg>';
    case 'moon':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="4.8"/><path d="M11 6a4 4 0 000 8" stroke-opacity="0.5"/></svg>';
    case 'lagrange':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 4v12M4 10h12"/><circle cx="10" cy="10" r="2.4"/></svg>';
    case 'free':
      return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="5.5" stroke-dasharray="2.5 2"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6"/></svg>';
  }
}

// CelestialClass から CenterGlyphKind への対応。
export function bodyClassGlyph(bodyClass: CelestialClass | null): CenterGlyphKind {
  if (bodyClass === 'star') return 'star';
  if (bodyClass === 'satellite') return 'moon';
  return 'planet';
}

// 回転タイル用のミニ SVG(20x20)。
export function rotationGlyphSvg(follow: CameraRotationFollow | null): string {
  if (follow === null) {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke-opacity="0.55"/><circle cx="10" cy="10" r="2.2" fill="currentColor"/></svg>';
  }
  if (follow.kind === 'attitude') {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><polygon points="10,4 14.5,14.5 10,12 5.5,14.5"/><path d="M3.5 10a6.5 6.5 0 012-4.6M16.5 10a6.5 6.5 0 00-2-4.6" stroke-dasharray="2 1.5"/></svg>';
  }
  if (follow.kind === 'spin') {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="10" cy="10" r="4.5"/><path d="M10 2.5v2M10 15.5v2"/><path d="M4.5 10c1.5 1.8 9.5 1.8 11 0"/></svg>';
  }
  return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="7" cy="10" r="2.4"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/><path d="M9.4 10h4.2" stroke-dasharray="2 1.5"/><path d="M13.5 5.2a6 6 0 012.5 3.1" stroke-linecap="round"/></svg>';
}

// 連動ピル用のリンク SVG(12x12)。
export function linkGlyphSvg(linked: boolean): string {
  return linked
    ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6.5 9.5l3-3M5 7L3.5 8.5a2.8 2.8 0 004 4L9 11M11 9l1.5-1.5a2.8 2.8 0 00-4-4L7 5"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 7L3.5 8.5a2.8 2.8 0 004 4L9 11M11 9l1.5-1.5a2.8 2.8 0 00-4-4L7 5"/><path d="M4 4l8 8" stroke-opacity="0.7"/></svg>';
}

// 透視/平行投影チップ用のミニ SVG(14x14)。
export function projectionGlyphSvg(orthographic: boolean): string {
  return orthographic
    ? '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 5h10M3 8h10M3 11h10"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 12.5L6.5 3.5h3l4 9"/></svg>';
}

// リアルタイム図式の入力状態。
export interface FrameDiagramState {
  readonly centerKind: CenterGlyphKind;
  readonly cameraRotating: boolean;
  readonly cameraRevolvingPair: boolean; // 二体公転(地球-月など)で相手天体を描くか
  readonly frameDetached: boolean; // 軌道フレームがカメラと別の基準か
  readonly frameRotating: boolean;
  readonly orthographic: boolean;
  readonly sideView: boolean;
}

// パネル最上段のリアルタイム座標系ミニ図式(94x74)。
export function frameDiagramSvg(s: FrameDiagramState): string {
  const ry = s.sideView ? 4.5 : 17;
  const fx = s.frameDetached ? 55 : 47;
  const fy = s.frameDetached ? 41 : 37;
  const parts: string[] = [
    '<line x1="47" y1="6" x2="47" y2="68" stroke="var(--fill-2)" stroke-width="1"/>',
    '<line x1="8" y1="37" x2="86" y2="37" stroke="var(--fill-2)" stroke-width="1"/>',
    `<ellipse cx="${fx}" cy="${fy}" rx="29" ry="${ry}" fill="none" stroke="var(--color-signal)" stroke-width="1.5"${s.frameRotating ? ' stroke-dasharray="4 2"' : ''} opacity="0.88"/>`,
  ];
  if (s.frameDetached) {
    parts.push(`<circle cx="${fx}" cy="${fy}" r="3" fill="var(--color-signal)" opacity="0.9"/>`);
  }
  if (s.cameraRotating) {
    parts.push('<path d="M 24 21 A 28 23 0 0 1 70 21" fill="none" stroke="var(--color-primary)" stroke-width="1.3" stroke-dasharray="3 2"/>');
    parts.push('<polygon points="72,23 66,21 70,16" fill="var(--color-primary)"/>');
  }
  if (s.centerKind === 'ship') {
    parts.push('<polygon points="47,29 53,42 47,39 41,42" fill="var(--color-primary)"/>');
  } else if (s.centerKind === 'target') {
    parts.push('<circle cx="47" cy="37" r="6" fill="none" stroke="var(--color-signal)" stroke-width="1.5"/><circle cx="47" cy="37" r="2" fill="var(--color-signal)"/>');
  } else if (s.centerKind === 'lagrange') {
    parts.push('<path d="M47 30v14M40 37h14" stroke="var(--color-primary)" stroke-width="1.5"/><circle cx="47" cy="37" r="2.8" fill="var(--color-primary)"/>');
  } else if (s.centerKind === 'free') {
    parts.push('<circle cx="47" cy="37" r="6" fill="none" stroke="var(--color-primary)" stroke-dasharray="2 2"/>');
  } else {
    const r = s.centerKind === 'moon' ? 5.5 : 8.5;
    parts.push(`<circle cx="47" cy="37" r="${r}" fill="var(--color-primary-fill)" stroke="var(--color-primary)" stroke-width="1.6"/>`);
    if (s.cameraRevolvingPair) {
      parts.push('<line x1="56" y1="37" x2="76" y2="37" stroke="var(--color-primary)" stroke-width="1" stroke-dasharray="2 2"/>');
      parts.push('<circle cx="76" cy="37" r="2.8" fill="var(--color-info)"/>');
    }
  }
  if (s.orthographic) {
    parts.push('<path d="M11 11h10M11 16h10" stroke="var(--color-primary)" stroke-width="1.3" opacity="0.8"/>');
  } else {
    parts.push('<path d="M11 14l10-4v8z" fill="none" stroke="var(--color-primary)" stroke-width="1.2" opacity="0.8"/>');
  }
  return parts.join('');
}

// 角度コンパス(108x92)の基準面リングと中心を描画する SVG。
// 「上」「横」の操作ボタンはキーボード操作・タッチのヒット領域を満たすため HTML button として重ねる。
export function angleCompassSvg(plane: CameraReferencePlane, activeView: CameraReferenceView | null): string {
  const ring = (
    id: CameraReferencePlane, rx: number, ry: number, rot: number, colorVar: string, dashed: boolean,
  ): string => {
    const active = plane === id;
    const sw = active ? '2' : '1.1';
    const op = active ? '0.95' : '0.32';
    const tf = rot === 0 ? '' : ` transform="rotate(${rot} 54 50)"`;
    const dash = dashed ? ' stroke-dasharray="3 2"' : '';
    return `<ellipse data-compass-plane="${id}" class="fc-compass-ring" cx="54" cy="50" rx="${rx}" ry="${ry}"${tf} fill="none" stroke="var(${colorVar})" stroke-width="${sw}"${dash} opacity="${op}"/>`;
  };
  const topLineOpacity = activeView === 'side' ? '0.35' : '0.85';
  const sideLineOpacity = activeView === 'side' ? '0.85' : '0.35';
  return [
    ring('ecliptic', 44, 19, 0, '--color-primary', false),
    ring('equator', 40, 17, -22, '--color-signal', true),
    ring('moonOrbit', 32, 13, 10, '--color-info', false),
    `<line x1="54" y1="43" x2="54" y2="20" stroke="var(--color-primary)" stroke-width="1.2" stroke-dasharray="2 2" opacity="${topLineOpacity}"/>`,
    `<line x1="61" y1="50" x2="86" y2="50" stroke="var(--color-primary)" stroke-width="1.2" stroke-dasharray="2 2" opacity="${sideLineOpacity}"/>`,
    '<circle cx="54" cy="50" r="6.5" fill="var(--color-primary-fill)" stroke="var(--color-primary)" stroke-width="1.4"/>',
  ].join('');
}
