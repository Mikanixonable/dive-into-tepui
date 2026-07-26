// 多数の対象を「画面上のマーカー集合」として破綻なく並べる表示器。対象の種類には
// 依存せず、投影後のスクリーン座標だけを見て
//   ① 画面上で近接するものを 1 つの代表にまとめる(代表以外はラベルを落とす)
//   ② 画面外へ出たものは画面端の方位マーカー(▲)に置き換える
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

// 画面外方位マーカーを置く円の半径(画面短辺の半分に対する比)。
const BEARING_RING_RATIO = 0.8;

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

    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    for (const m of placed) {
      const label = m.labeled ? this.label(m.item, m.count) : '';
      this.markerManager.set(m.item.key, m.item.cls, m.item.sym, m.p.x, m.p.y, m.p.front, label);
      this.syncBearing(m.item, m.p, cx, cy);
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

  // 画面外(背面を含む)の対象は、画面中心から見た方位を画面端の ▲ で示す。
  private syncBearing(item: GroupedMarkerItem, p: Projected, cx: number, cy: number): void {
    const onScreen = p.front && p.x >= 0 && p.x <= window.innerWidth && p.y >= 0 && p.y <= window.innerHeight;
    if (onScreen) {
      this.markerManager.hide(bearingKey(item.key));
      return;
    }
    // 背面の対象は投影が反転しているので、方位も反転させる
    const sign = p.front ? 1 : -1;
    const ang = Math.atan2(sign * (p.y - cy), sign * (p.x - cx));
    const ring = Math.min(cx, cy) * BEARING_RING_RATIO;
    this.markerManager.set(
      bearingKey(item.key), 'mk-dir', '▲',
      cx + ring * Math.cos(ang), cy + ring * Math.sin(ang), true,
      '', 0.6, item.bearingColor,
      (ang * 180) / Math.PI + 90, // '▲' は上向きなので方位角に 90° 足して回す
    );
  }

  private retire(keys: readonly string[]): void {
    const kept = new Set(keys);
    for (const key of this.shownKeys) {
      if (kept.has(key)) continue;
      this.markerManager.hide(key);
      this.markerManager.hide(bearingKey(key));
    }
    this.shownKeys = keys;
  }
}
