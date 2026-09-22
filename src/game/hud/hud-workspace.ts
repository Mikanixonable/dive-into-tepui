// HUD の表示文脈。ViewMode（カメラ/描画の戦闘・マップ）とは分け、建造などの一時 UI を同じ軸へ混ぜない。
import type { ViewMode } from '../view/view-mode';

export type HudWorkspace = 'flight' | 'map' | 'construction';
export type HudAttention = 'nominal' | 'engagement';

// 現在のビューと、通常ビューを上書きする建造セッションから HUD 全体の作業文脈を決める。
export function hudWorkspace(view: ViewMode, constructionActive: boolean): HudWorkspace {
  if (constructionActive) return 'construction';
  return view === 'map' ? 'map' : 'flight';
}

// 戦闘は独立 workspace にせず、flight 内の注意状態として扱う。ターゲットの有無で配置を揺らさず、
// 見た目の強弱だけを切り替える。
export function hudAttention(
  view: ViewMode, constructionActive: boolean, hasCombatTarget: boolean,
): HudAttention {
  if (constructionActive || view === 'map') return 'nominal';
  return hasCombatTarget ? 'engagement' : 'nominal';
}
