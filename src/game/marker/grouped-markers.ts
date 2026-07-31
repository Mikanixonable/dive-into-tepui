// 多数の対象を「画面上のマーカー集合」として破綻なく並べる表示器。対象の種類には
// 依存せず、投影後のスクリーン座標だけを見て
//   ① 画面上で近接するものを 1 つの代表にまとめる(代表以外はラベルを落とす)
//   ② 画面外へ出たものは画面端の方位マーカー(▲)に置き換える(置き方そのものは
//      MarkerManager.setBearing の担当で、ここは対象ごとに呼ぶだけ)
// を行う。どちらも「対象 1 体では決められない = 集合の側の責務」であり、逆に対象ごとの
// 見た目とラベル内容(GroupedMarkerItem)は対象自身が用意する。
import { Vec3 } from '../../physics/vec3';
import { Projected } from '../../physics/projection';
import { ProjectFn } from '../camera/camera-system';
import { MarkerManager } from './marker-manager';

export interface GroupedMarkerItem {
  key: string; // 対象を一意に識別するマーカーキー
  cls: string; // 画面内マーカーの CSS クラス
  sym: string; // 画面内マーカーの記号
  pos: Vec3; // ワールド位置 (ECI)
  priority: number; // 代表選出の優先度(大きいものが代表になる)
  name: string; // ラベルの主題。まとめられた代表には "xN" が付く
  detail: string; // ラベル末尾の付随情報(距離など)
  bearingColor: string; // 画面外方位マーカーの色
}

const bearingKey = (key: string): string => `${key}-bearing`;

interface PlacedItem {
  item: GroupedMarkerItem;
  p: Projected;
  count: number; // 自分がまとめた件数(1 = 単独)
  labeled: boolean; // false = 代表に吸収されたのでラベルを出さない
}

export class GroupedMarkers {
  // 前フレームに出したキー。集合から消えた対象のマーカーを片付けるために覚えておく。
  private shownKeys: readonly string[] = [];

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly clusterRadiusPx: number,
  ) { }

  // items が空なら前フレームのマーカーをすべて片付けるだけになる(非表示にしたいときは
  // 空配列を渡せばよく、専用の hide は要らない)。
  sync(items: readonly GroupedMarkerItem[], project: ProjectFn): void {
    const placed: PlacedItem[] = items.map(
      (item) => ({ item, p: project(item.pos), count: 1, labeled: true }),
    );
    this.groupNearby(placed);

    for (const m of placed) {
      const label = m.labeled ? this.label(m.item, m.count) : '';
      this.markerManager.set(m.item.key, m.item.cls, m.item.sym, m.p.x, m.p.y, m.p.front, label);
      // 画面外(背面を含む)の対象は、画面端の ▲ で方位だけを示す。
      this.markerManager.setBearing(bearingKey(m.item.key), 'mk-dir', '▲', m.p, '', 0.6, m.item.bearingColor);
    }

    this.retire(items.map((item) => item.key));
  }

  // 画面手前にあるものだけをクラスタ化し、優先度が最大のものを代表に据える。
  private groupNearby(placed: readonly PlacedItem[]): void {
    const groups: PlacedItem[][] = [];
    for (const m of placed) {
      if (!m.p.front) continue;
      const near = groups.find((g) => this.isNear(g[0]!.p, m.p));
      if (near) near.push(m);
      else groups.push([m]);
    }
    for (const g of groups) {
      if (g.length <= 1) continue;
      g.sort((a, b) => b.item.priority - a.item.priority);
      g[0]!.count = g.length;
      for (const m of g.slice(1)) m.labeled = false;
    }
  }

  private isNear(a: Projected, b: Projected): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) < this.clusterRadiusPx;
  }

  private label(item: GroupedMarkerItem, count: number): string {
    return count > 1 ? `${item.name} x${count} ${item.detail}` : `${item.name} ${item.detail}`;
  }

  // key は対象(敵)ごとに一意で増え続けるため hide ではなく remove で DOM ごと片付ける。
  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (kept.has(key)) continue;
      this.markerManager.remove(key);
      this.markerManager.remove(bearingKey(key));
    }
    this.shownKeys = keys;
  }
}
