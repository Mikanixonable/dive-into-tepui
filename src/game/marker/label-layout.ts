// 間引きを生き残ったラベルどうしが画面上で重ならないよう、既定位置から押し出して置き直す。
// 既定位置からずれたラベルには、シンボルとラベルを結ぶ引き出し線を SVG で引く。
// どのラベルを消すかは決めない(消すものは呼び出し元がキー集合で渡す)。

// ラベルの概算矩形を入れる画面空間グリッドのセル幅。ラベルの幅は文字数に
// よって変わるため、各ラベルは矩形がまたがる全セルへ登録する。
const COLLISION_BUCKET_SIZE = 64;
const COLLISION_PADDING = 4;

// 押し出しの対象になるラベル1件。
export interface LayoutTarget {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  // ラベル位置を固定する対象は押し出さない。
  readonly fixedLabel: boolean;
  // 引き出し線の不透明度を合わせるために読む。
  readonly root: HTMLElement;
  readonly lbl: HTMLElement;
}

// 押し出しの途中経過。ox/oy が既定位置、dx/dy がそこからの累積オフセット [px]。
interface ActiveLabel {
  m: LayoutTarget;
  ox: number;
  oy: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
}

export class LabelLayout {
  private readonly activeScratch: ActiveLabel[] = [];
  private activeCount = 0;
  private candidateStamp = new Int32Array(0);
  private readonly candidatesScratch: number[] = [];
  // セル添字 (cellX, cellY) を x → y の二段の Map で引く。添字をそのまま鍵にするので、
  // 別のセルが同じ鍵を共有することはない。
  private readonly collisionBuckets = new Map<number, Map<number, number[]>>();
  private readonly bucketPool: number[][] = [];
  private readonly bucketRowPool: Map<number, number[]>[] = [];
  private readonly svgLinePool: SVGLineElement[] = [];

  // svgOverlay: ラベル引き出し線を描く SVG。
  public constructor(private readonly svgOverlay: SVGSVGElement) {}

  // targets のラベルを重ならない位置へ置き直す。hiddenLabels に載るキーと、ラベルを持たない
  // 対象は既定位置へ戻す。全マーカーが出揃った後に一度だけ呼ぶこと。
  public sync(targets: readonly LayoutTarget[], hiddenLabels: ReadonlySet<string>): void {
    this.relaxLabelRects(targets, hiddenLabels);
    this.applyLabelOffsets();
  }

  // 引き出し線のプールを片付ける。svgOverlay 自体は所有していないので中身を空にするだけ。
  public dispose(): void {
    for (const line of this.svgLinePool) line.remove();
    this.svgLinePool.length = 0;
  }

  // 押し出しの対象になるラベルの推定矩形を集め、重なったものどうしをグリッドバケット +
  // 5反復で反発させて緩和する。結果のオフセットは activeScratch/activeCount へ蓄積し、
  // 位置の反映と引き出し線の描画は applyLabelOffsets が行う。
  private relaxLabelRects(targets: readonly LayoutTarget[], hiddenLabels: ReadonlySet<string>): void {
    const active = this.activeScratch;
    this.activeCount = 0;

    // 表示中のマーカーと、そのラベルの推定矩形を集める
    for (const m of targets) {
      if (hiddenLabels.has(m.key) || !m.lbl.textContent || m.fixedLabel) {
        m.lbl.style.transform = 'translateX(-50%)';
        continue;
      }
      const x = m.x;
      const y = m.y;

      const textLen = m.lbl.textContent.length;
      const w = textLen * 6.5 + 4; // 概算幅 [px]
      const h = 14;

      // ラベル中心の既定位置は、シンボル中心 (x, y) の 12px + h/2 下
      const index = this.activeCount++;
      const a = active[index] ?? (active[index] = { m, ox: 0, oy: 0, w: 0, h: 0, dx: 0, dy: 0 });
      a.m = m;
      a.ox = x;
      a.oy = y + 12 + h / 2;
      a.w = w;
      a.h = h;
      a.dx = 0;
      a.dy = 0;
    }

    // 重なったラベルどうしを反発させて緩和する
    const ITER = 5;
    if (this.candidateStamp.length < this.activeCount) this.candidateStamp = new Int32Array(this.activeCount);
    this.candidateStamp.fill(0, 0, this.activeCount);
    const candidateStamp = this.candidateStamp;
    const candidates = this.candidatesScratch;
    for (let iter = 0; iter < ITER; iter++) {
      // 現在の押し出し位置からグリッドを作り直す。ラベルが前の反復で別セルへ
      // 移動しても候補から漏れないよう、反復をまたいでバケットを再利用しない。
      for (const row of this.collisionBuckets.values()) {
        for (const bucket of row.values()) {
          bucket.length = 0;
          this.bucketPool.push(bucket);
        }
        row.clear();
        this.bucketRowPool.push(row);
      }
      this.collisionBuckets.clear();
      const buckets = this.collisionBuckets;
      for (let i = 0; i < this.activeCount; i++) {
        const a = active[i]!;
        const cx = a.ox + a.dx;
        const cy = a.oy + a.dy;
        const halfW = a.w / 2 + COLLISION_PADDING;
        const halfH = a.h / 2 + COLLISION_PADDING;
        const minCellX = Math.floor((cx - halfW) / COLLISION_BUCKET_SIZE);
        const maxCellX = Math.floor((cx + halfW) / COLLISION_BUCKET_SIZE);
        const minCellY = Math.floor((cy - halfH) / COLLISION_BUCKET_SIZE);
        const maxCellY = Math.floor((cy + halfH) / COLLISION_BUCKET_SIZE);

        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
            let row = buckets.get(cellX);
            if (!row) {
              row = this.bucketRowPool.pop() ?? new Map<number, number[]>();
              buckets.set(cellX, row);
            }
            let bucket = row.get(cellY);
            if (!bucket) {
              bucket = this.bucketPool.pop() ?? [];
              row.set(cellY, bucket);
            }
            bucket.push(i);
          }
        }
      }

      for (let i = 0; i < this.activeCount; i++) {
        const a = active[i]!;
        const ax = a.ox + a.dx;
        const ay = a.oy + a.dy;

        // ラベルの押し出し判定に必要なセルだけを辿る。矩形をまたがる全セルへ
        // 登録しているため、重なり得る2矩形は少なくとも1セルを共有する。
        const halfW = a.w / 2 + COLLISION_PADDING;
        const halfH = a.h / 2 + COLLISION_PADDING;
        const minCellX = Math.floor((ax - halfW) / COLLISION_BUCKET_SIZE);
        const maxCellX = Math.floor((ax + halfW) / COLLISION_BUCKET_SIZE);
        const minCellY = Math.floor((ay - halfH) / COLLISION_BUCKET_SIZE);
        const maxCellY = Math.floor((ay + halfH) / COLLISION_BUCKET_SIZE);

        candidates.length = 0;
        const stamp = i + 1;
        for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
          const row = buckets.get(cellX);
          if (!row) continue;
          for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
            const bucket = row.get(cellY);
            if (!bucket) continue;
            for (const j of bucket) {
              if (j > i && candidateStamp[j] !== stamp) {
                candidateStamp[j] = stamp;
                candidates.push(j);
              }
            }
          }
        }

        // 押し出しは累積するので結果が処理順に依る。バケットの巡回順はセル配置に依存して
        // 揺れるため、添字の昇順へ均してから解決する。
        candidates.sort((left, right) => left - right);
        for (const j of candidates) {
          const b = active[j]!;
          const bx = b.ox + b.dx;
          const by = b.oy + b.dy;
          const minDistX = (a.w + b.w) / 2 + COLLISION_PADDING;
          const minDistY = (a.h + b.h) / 2 + COLLISION_PADDING;
          const dx = ax - bx;
          const dy = ay - by;
          if (Math.abs(dx) < minDistX && Math.abs(dy) < minDistY) {
            const ex = minDistX - Math.abs(dx);
            const ey = minDistY - Math.abs(dy);
            if (ex < ey) {
              const push = (ex / 2 + 0.5) * Math.sign(dx || 1);
              a.dx += push;
              b.dx -= push;
            } else {
              const push = (ey / 2 + 0.5) * Math.sign(dy || 1);
              a.dy += push;
              b.dy -= push;
            }
          }
        }
      }
    }
  }

  // relaxLabelRects が求めたオフセットを DOM の transform へ反映し、ずれたラベルにはシンボルへの
  // 引き出し線を引く。線を使わなくなったスロットは display: none で隠す(プールは再利用する)。
  private applyLabelOffsets(): void {
    const active = this.activeScratch;
    let lineIndex = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const a = active[i]!;
      if (Math.abs(a.dx) > 1 || Math.abs(a.dy) > 1) {
        a.m.lbl.style.transform = `translate(calc(-50% + ${a.dx}px), ${a.dy}px)`;
        const line = this.svgLinePool[lineIndex] ?? document.createElementNS('http://www.w3.org/2000/svg', 'line');
        if (lineIndex === this.svgLinePool.length) this.svgLinePool.push(line);
        line.style.display = '';
        line.setAttribute('x1', a.ox.toString());
        line.setAttribute('y1', (a.oy - 12 - a.h / 2).toString());
        line.setAttribute('x2', (a.ox + a.dx).toString());
        line.setAttribute('y2', (a.oy + a.dy - a.h / 2).toString());
        line.setAttribute('class', 'mk-lead');
        line.setAttribute('stroke-width', '1');
        const opacity = a.m.root.style.opacity;
        if (opacity) {
          line.setAttribute('stroke-opacity', opacity);
        } else {
          line.removeAttribute('stroke-opacity');
        }
        // 既存ノードの appendChild は同じノードを移動するだけなので、active 順を保つ。
        this.svgOverlay.appendChild(line);
        lineIndex++;
      } else {
        a.m.lbl.style.transform = 'translateX(-50%)';
      }
    }
    for (; lineIndex < this.svgLinePool.length; lineIndex++) this.svgLinePool[lineIndex]!.style.display = 'none';
  }
}
