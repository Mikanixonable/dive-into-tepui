// 多数の対象を「画面上のマーカー集合」として破綻なく並べる表示器。対象の種類には
// 依存せず、投影後のスクリーン座標だけを見て
//   ① 画面上で近接するものを 1 つの代表にまとめる(代表以外はラベルを落とす)
//   ② 画面外へ出たものは画面端の方位マーカー(▲)に置き換える(置き方そのものは
//      MarkerManager.setBearing の担当で、ここは対象ごとに呼ぶだけ)
// を行う。どちらも「対象 1 体では決められない = 集合の側の責務」であり、逆に対象ごとの
// 見た目とラベル内容(GroupedMarkerItem)は対象自身が用意する。
import { Vec3, len, sub } from '../../math/vec3';
import { Projected } from '../../math/projection';
import type { ProjectFn, ScaleFn } from '../camera/camera-system';
import type { ActiveCelestialLabel } from '../camera/focus-markers';
import type { MarkerManager } from './marker-manager';
import { DIRECTION_GLYPH } from './marker-glyphs';
import type { CelestialBody } from '../../physics/celestial-body';
import type { FrameAnchorSource, ReferenceFrame } from '../../physics/frame';
import type { ReferenceFrames } from '../../physics/reference-frames';
import { resolveCrowdingWinner } from './crowding';
import * as C from '../const';

export interface GroupedMarkerItem {
  key: string; // 対象を一意に識別するマーカーキー
  cls: string; // 画面内マーカーの CSS クラス
  sym: string; // 画面内マーカーの記号
  pos: Vec3; // ワールド位置 (ECI)
  vel: Vec3; // ECI 速度。マップビューでの進行方向表示に使う
  priority: number; // 代表選出の優先度(大きいものが代表になる)
  name: string; // ラベルの主題。まとめられた代表には "xN" が付く
  detail: string; // ラベル末尾の付随情報(距離など)
  bearingColor: string; // 画面外方位マーカーの色
  bearingSym?: string; // 画面外方位マーカーの記号。省略時は通常の矢印
  bearingClass?: string; // 画面外方位マーカーの CSS クラス
  bearingVisible?: boolean; // false のときは画面外でも方位マーカーを出さない
  color?: string; // 画面内マーカー自体の色。省略時は cls の CSS 色に従う
  symMarkup?: boolean;
  opacity?: number; // 画面内マーカーの不透明度。0 以下なら非表示
  occluded?: boolean; // 惑星遮蔽中は表示位置を維持したままフェードアウトする
}

const bearingKey = (key: string): string => `${key}-bearing`;

interface PlacedItem {
  item: GroupedMarkerItem;
  p: Projected;
  dist: number | undefined;
  count: number; // 自分がまとめた件数(1 = 単独)
  labeled: boolean; // false = 代表に吸収されたのでラベルを出さない
  groupMembers?: readonly GroupedMarkerItem[];
  hiddenByCelestialLabel?: boolean;
}

export class GroupedMarkers {
  // 前フレームに出したキー。集合から消えた対象のマーカーを片付けるために覚えておく。
  private shownKeys: readonly string[] = [];
  private readonly visibleKeys = new Set<string>();
  private readonly hiddenItemsList: GroupedMarkerItem[] = [];
  // 天体ラベルとの近接で前フレームに隠したキー(depth-guard のヒステリシス用)。
  private prevHiddenByCelestialLabel = new Set<string>();

  isPickable(key: string): boolean {
    return this.visibleKeys.has(key);
  }

  getHiddenItems(): readonly GroupedMarkerItem[] {
    return this.hiddenItemsList;
  }

  constructor(
    private readonly markerManager: MarkerManager,
    private readonly clusterRadiusPx: number,
  ) { }

  // items が空なら前フレームのマーカーをすべて片付けるだけになる(非表示にしたいときは
  // 空配列を渡せばよく、専用の hide は要らない)。overviewMode 中は対象そのものが
  // 画面内に見えているので、画面端の方位マーカーは出さず、代わりに vel から進行方向を
  // 求めてマーカー自体を回す(円軌道では静止画から回転方向が読めないための対策)。
  sync(
    items: readonly GroupedMarkerItem[],
    project: ProjectFn,
    overviewMode: boolean,
    scale: ScaleFn,
    celestialLabels: readonly ActiveCelestialLabel[] = [],
    celestialBodies: readonly CelestialBody[] = [],
    cameraPos?: Vec3,
    frame?: ReferenceFrame,
    displayTime?: number,
    frames?: ReferenceFrames,
    frameAnchors?: FrameAnchorSource,
  ): void {
    const placed: PlacedItem[] = items.map(
      (item) => ({ item, p: project(item.pos), dist: cameraPos ? len(sub(item.pos, cameraPos)) : undefined, count: 1, labeled: true }),
    );
    this.groupNearby(placed, celestialLabels);

    for (const m of placed) {
      const opacity = m.item.opacity ?? 1;
      if (m.item.occluded) {
        this.markerManager.fadeOut(m.item.key);
        this.markerManager.hide(bearingKey(m.item.key));
        continue;
      }
      if (opacity <= 0) {
        this.markerManager.hide(m.item.key);
        this.markerManager.hide(bearingKey(m.item.key));
        continue;
      }
      const label = m.labeled ? this.label(m.item, m.count, m.groupMembers) : '';
      const rotationDeg = overviewMode
        ? this.markerManager.headingRotationDeg(m.item.pos, m.item.vel, project, scale, celestialBodies, frame, displayTime, frames, frameAnchors)
        : undefined;
      this.markerManager.set(
        m.item.key, m.item.cls, m.item.sym, m.p.x, m.p.y, m.p.front, label, opacity, m.item.color,
        rotationDeg, m.item.symMarkup, false, m.item.priority, m.dist,
      );
      // 画面外(背面を含む)の対象は、画面端の方位マーカーで方位だけを示す。
      // bearingVisible は味方機など、距離によって方位マーカーを抑制する対象に使う。
      if (overviewMode || m.item.bearingVisible === false) this.markerManager.hide(bearingKey(m.item.key));
      else this.markerManager.setBearing(
        bearingKey(m.item.key), m.item.bearingClass ?? 'mk-dir', m.item.bearingSym ?? DIRECTION_GLYPH.bearing,
        m.p, '', 1, m.item.bearingColor,
      );
    }

    this.visibleKeys.clear();
    this.hiddenItemsList.length = 0;
    const addedKeys = new Set<string>();

    for (const m of placed) {
      const opacity = m.item.opacity ?? 1;
      if (m.labeled && opacity > 0 && !m.item.occluded && m.p.front) {
        this.visibleKeys.add(m.item.key);
      }
      // 天体ラベルと近接してマーカーが非表示化され、かつ惑星に遮蔽(掩蔽)されていないオブジェクトのみを天体サブ行の候補とする
      if (m.hiddenByCelestialLabel && !m.item.occluded && m.p.front) {
        if (m.groupMembers && m.groupMembers.length > 0) {
          for (const member of m.groupMembers) {
            if (!addedKeys.has(member.key) && !member.occluded) {
              addedKeys.add(member.key);
              this.hiddenItemsList.push(member);
            }
          }
        } else if (!addedKeys.has(m.item.key)) {
          addedKeys.add(m.item.key);
          this.hiddenItemsList.push(m.item);
        }
      }
    }

    this.retire(items.map((item) => item.key));
  }

  // 画面手前にあるものだけをクラスタ化し、優先度が最大のものを代表に据える。
  // 天体ラベルと近接している船マーカーは天体優先(天体 > 船)でラベルを落とす。
  private groupNearby(placed: readonly PlacedItem[], celestialLabels: readonly ActiveCelestialLabel[]): void {
    // 画面座標が近いものを同じグループへまとめる
    const groups: PlacedItem[][] = [];
    for (const m of placed) {
      if (!m.p.front || (m.item.opacity ?? 1) <= 0) continue;
      const near = groups.find((g) => this.isNear(g[0]!.p, m.p));
      if (near) near.push(m);
      else groups.push([m]);
    }
    // グループ内は優先度最大を代表にし、残りはラベルを落とす
    for (const g of groups) {
      if (g.length <= 1) continue;
      g.sort((a, b) => b.item.priority - a.item.priority);
      g[0]!.count = g.length;
      g[0]!.groupMembers = g.map((m) => m.item);
      for (const m of g.slice(1)) m.labeled = false;
    }
    // 天体ラベルと画面上で近接している船マーカーはラベルを隠す。ただし船がカメラに著しく
    // 近く天体が著しく遠い(depth-guard)場合は、優先度(天体 > 船)に関わらず船を残す —
    // 手前の船が奥の天体ラベルに隠され続けることを防ぐ(DEVELOP/SPEC/MAP.md 7.2 節)。
    const nowHiddenByCelestialLabel = new Set<string>();
    if (celestialLabels.length > 0) {
      for (const m of placed) {
        if (!m.labeled || !m.p.front) continue;
        for (const c of celestialLabels) {
          if (!c.labelVisible || Math.hypot(m.p.x - c.x, m.p.y - c.y) >= this.clusterRadiusPx) continue;
          // 天体ラベル側(c)の前フレームの間引き状態はここでは追跡していない(focus-markers.ts が
          // 別に持つ)ため、常に基準の depthGuardRatio を使う(false)。
          const pick = resolveCrowdingWinner(
            m.item.key, m.item.priority, m.dist, this.prevHiddenByCelestialLabel.has(m.item.key),
            c.id, c.priority, c.dist, false,
            C.DEPTH_GUARD_RATIO, C.DEPTH_GUARD_EXIT_RATIO, true,
          );
          if (pick !== 'a') continue;
          m.labeled = false;
          m.hiddenByCelestialLabel = true;
          nowHiddenByCelestialLabel.add(m.item.key);
          break;
        }
      }
    }
    this.prevHiddenByCelestialLabel = nowHiddenByCelestialLabel;
  }

  // a と b がクラスタ化する距離内にあるか判定する。
  private isNear(a: Projected, b: Projected): boolean {
    return Math.hypot(a.x - b.x, a.y - b.y) < this.clusterRadiusPx;
  }

  // 代表のラベル文字列を組み立てる。
  //   - 2隻近接の時: 2行でそれぞれの正式名称を、各自の色で表示
  //   - 3隻以上近接の時: "xN" の形式とし、正式名称は表示しない
  private label(item: GroupedMarkerItem, count: number, members?: readonly GroupedMarkerItem[]): string {
    if (count === 2 && members && members.length >= 2) {
      const line = (m: GroupedMarkerItem): string => m.color
        ? `<span style="color:${m.color}">${m.name}</span>`
        : m.name;
      return `${line(members[0]!)}\n${line(members[1]!)}`;
    }
    if (count >= 3) {
      return `x${count}`;
    }
    return item.detail === '' ? item.name : `${item.name}\n${item.detail}`;
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
