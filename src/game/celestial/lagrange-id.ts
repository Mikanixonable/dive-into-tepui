// ラグランジュ点の識別子 `${親天体id}-l${点番号}`。点は天体レジストリに載らないが、マップの
// 選択・フォーカス対象としては天体と同じ名前空間に入る。**その名前空間を跨ぐ唯一の規約なので、
// 組み立てと解釈の両方をここへ閉じる** — 別々に正規表現を持つと、片方だけが緩んだときに天体で
// ない対象がラグランジュ点として解決される。点の位置と成立条件は physics/lagrange.ts が持つ。

// L1〜L5 の点番号。
export type LagrangePointNumber = 1 | 2 | 3 | 4 | 5;

// 親 id を `.+` で受けるので、親を持たない `-l1` のような文字列は形として通らない。
const LAGRANGE_ID = /^(.+)-l([1-5])$/;

// 親天体 id と点番号からラグランジュ点の識別子を組む。
export function lagrangeId(parentId: string, point: LagrangePointNumber): string {
  return `${parentId}-l${point}`;
}

// id がラグランジュ点の形かどうか。**形だけの判定なので、親天体がレジストリに実在するかまで
// 要るなら、続けて CelestialSystem へ問い合わせること。**
export function isLagrangeId(id: string): boolean {
  return LAGRANGE_ID.test(id);
}

// ラグランジュ点 id からその親天体の id を取り出す。ラグランジュ点でない id は無変換で返る。
export function lagrangeParentId(id: string): string {
  return LAGRANGE_ID.exec(id)?.[1] ?? id;
}

// ラグランジュ点 id を親天体と点番号へ分解する。ラグランジュ点でなければ null。
export function lagrangePointOf(
  id: string,
): { readonly parentId: string; readonly point: LagrangePointNumber } | null {
  const match = LAGRANGE_ID.exec(id);
  return match === null ? null : { parentId: match[1]!, point: Number(match[2]) as LagrangePointNumber };
}
