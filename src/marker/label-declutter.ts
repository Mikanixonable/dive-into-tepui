// 画面上で近接したマーカーのうち、どのラベル・どのアイコンを間引くかを決める。DOM には触れず、
// 隠す対象の id 集合だけを返す。近接の判定半径は、いったん隠したものを出し直すときだけ緩める。
// 近接した2つのどちらを残すかの規則そのものは crowding.ts が持つ。
import { resolveCrowdingWinner, DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO } from './crowding';

// これより画面上で近いマーカー同士は、優先度の低い側のラベルを間引く [px]
const MARKER_CROWDING_PX = 40;

// 一度隠したラベル/アイコンを再び出す画面距離のしきい値(MARKER_CROWDING_PX より緩い値)。
// 同じ値だと境界ちょうどで距離が揺れたときに毎フレーム表示・非表示が反転する
// (周期が数時間の衛星どうしなど、タイムワープ中に画面距離が急変する組で顕著)。
const MARKER_CROWDING_RELEASE_PX = 60;

// 優先度の差がこれ以上ある組(例: 天体 > 船、船 > 弾薬、船 > 軌道要素)は、ラベルだけでなく
// アイコンも隠す。同じ種別どうしの重なりではアイコンを残す。
const ICON_HIDE_PRIORITY_GAP = 100;

// 間引きの判定に要る、投影済みのマーカー1件。
export interface DeclutterTarget {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly priority: number;
  // 視点からの距離。持たない対象は undefined(depth-guard を評価しない)。
  readonly dist: number | undefined;
  // ラベル位置を固定する対象はアイコンを消さない。
  readonly fixedLabel: boolean;
  // 混雑してもアイコンを残す対象は false。
  readonly iconHidable: boolean;
  // 近接まとめでアイコンの扱いが既に決まっている対象。同じ扱いの対どうしではアイコンを消さない。
  readonly clustered: boolean;
  // 直前のフレームでラベルを間引いていたか。近接半径と depth-guard のヒステリシスに使う。
  readonly prevLabelHidden: boolean;
}

// 間引きで隠すマーカーの id。どちらの集合も次回の compute まで有効。
export interface HiddenMarkerIds {
  readonly labels: ReadonlySet<string>;
  readonly icons: ReadonlySet<string>;
}

// 表示中のマーカー全体を見て、混雑した組のラベル・アイコンを間引く。
// 隠す/再び出すしきい値を対象自身の直前フレームの状態で分ける(ヒステリシス)ため、
// 呼び出し元は返り値を次フレームの prevLabelHidden として書き戻すこと。
export class LabelDeclutter {
  private readonly hiddenLabels = new Set<string>();
  private readonly hiddenIcons = new Set<string>();

  // targets の全ペアのうち画面上で近接した組について、隠す側の id を集める。
  // hideCrowded が偽なら、どちらの集合も空で返る。
  public compute(targets: readonly DeclutterTarget[], hideCrowded: boolean): HiddenMarkerIds {
    const labels = this.hiddenLabels;
    const icons = this.hiddenIcons;
    labels.clear();
    icons.clear();
    if (!hideCrowded) return { labels, icons };

    for (let i = 0; i < targets.length; i++) {
      const a = targets[i]!;
      for (let j = i + 1; j < targets.length; j++) {
        const b = targets[j]!;
        const pick = resolveCrowdingWinner(
          a.id, a.priority, a.dist, a.prevLabelHidden,
          b.id, b.priority, b.dist, b.prevLabelHidden,
          DEPTH_GUARD_RATIO, DEPTH_GUARD_EXIT_RATIO, false,
        );
        if (pick === undefined) continue;
        const [loser, winner] = pick === 'a' ? [a, b] : [b, a];
        const threshold = loser.prevLabelHidden ? MARKER_CROWDING_RELEASE_PX : MARKER_CROWDING_PX;
        if (Math.hypot(a.x - b.x, a.y - b.y) >= threshold) continue;

        labels.add(loser.id);
        // depth-guard で優先度が逆転して隠れた側(手前の低優先度が奥の高優先度を隠した)でも、
        // 種別の隔たりの大きさそのものは変わらないため絶対値で見る。
        if (Math.abs(winner.priority - loser.priority) >= ICON_HIDE_PRIORITY_GAP
          && !loser.fixedLabel && loser.iconHidable
          && !(winner.clustered && loser.clustered)) {
          icons.add(loser.id);
        }
      }
    }
    return { labels, icons };
  }
}
