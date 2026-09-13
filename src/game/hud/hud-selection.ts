// ランを跨いで残る HUD の選択(パネルの折りたたみ、パネル内のタブ)の値と、保存文字列との変換。
import { GUIDE_GROUPS } from '../celestial/orbit-guide/orbit-guide-settings';
import type { GuideGroupId } from '../celestial/orbit-guide/orbit-guide-settings';
import type { ViewMode } from '../../render/view-mode';

// 折りたたみトグルの id → 畳んでいるか。一度も操作されていない id は載らない。
type PanelCollapsedBucket = Record<string, boolean>;

// 折りたたみ状態はビューごとに独立して残る。
export type PanelCollapsedState = Readonly<Record<ViewMode, PanelCollapsedBucket>>;

// 表示パネルのタブ。
export type ViewOptionsTab = 'target' | 'guide' | 'orbit';

const VIEW_OPTIONS_TABS: readonly ViewOptionsTab[] = ['target', 'guide', 'orbit'];

// 軌道ガイドタブの群タブ。GuideGroupId(データ分類)に「基本」を加えた UI 専用の型。
export type OrbitGuideGroupTab = 'basic' | GuideGroupId;

export const ORBIT_GUIDE_GROUP_TABS: readonly OrbitGuideGroupTab[] = ['basic', ...GUIDE_GROUPS];

// 保存値のうち真偽値だけを畳み状態として採る。
function parseBucket(parsed: unknown): PanelCollapsedBucket | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const bucket: PanelCollapsedBucket = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === 'boolean') bucket[id] = value;
  }
  return bucket;
}

// JSON 文字列を1ビューぶんの畳み状態表として読む。読めなければ null。
function parseBucketText(text: string | null): PanelCollapsedBucket | null {
  if (text === null || text === '') return null;
  try {
    return parseBucket(JSON.parse(text));
  } catch {
    return null;
  }
}

// ビュー別の折りたたみ状態を読み直す。text が読めないときは、ビュー別でない保存値 legacy を
// 両ビューへ移す。
export function parsePanelCollapsed(text: string | null, legacy: string | null): PanelCollapsedState {
  if (text !== null && text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const source = parsed as Record<string, unknown>;
        return { combat: parseBucket(source['combat']) ?? {}, map: parseBucket(source['map']) ?? {} };
      }
    } catch {
      // 保存先が壊れていても既定値で続行する。
    }
  }
  const moved = parseBucketText(legacy) ?? {};
  return { combat: { ...moved }, map: { ...moved } };
}

// 折りたたみ状態を保存へ載せる文字列にする。
export function formatPanelCollapsed(state: PanelCollapsedState): string {
  return JSON.stringify(state);
}

// 保存された表示パネルのタブ。知らない値は「対象」へ落ちる。
export function parseViewOptionsTab(text: string | null): ViewOptionsTab {
  return VIEW_OPTIONS_TABS.find((tab) => tab === text) ?? 'target';
}

// 表示パネルのタブを保存へ載せる文字列にする。
export function formatViewOptionsTab(tab: ViewOptionsTab): string {
  return tab;
}

// 保存された軌道ガイドの群タブ。知らない値は「基本」へ落ちる。
export function parseOrbitGuideGroupTab(text: string | null): OrbitGuideGroupTab {
  return ORBIT_GUIDE_GROUP_TABS.find((tab) => tab === text) ?? 'basic';
}

// 軌道ガイドの群タブを保存へ載せる文字列にする。
export function formatOrbitGuideGroupTab(tab: OrbitGuideGroupTab): string {
  return tab;
}
