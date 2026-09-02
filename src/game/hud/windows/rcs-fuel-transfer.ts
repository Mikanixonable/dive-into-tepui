// 艦の RCS タンク群に対する燃料の補給・移送・均等化。複数タンクをまたぐ配分の規則だけを
// 持ち、どのタンクからどの順に汲むかをここで決める。
import type { Player } from '../../player/player';
import type { RcsTankPart } from '../../dynamic/dynamic-entity/parts';

// entity が搭載する RCS タンクを取り出す。
export function rcsTanksOf(entity: Player): readonly RcsTankPart[] {
  return entity.parts.filter((p): p is RcsTankPart => p.type === 'rcs_tank');
}

// タンク群の残量合計と容量合計を返す。
export function rcsFuelTotals(tanks: readonly RcsTankPart[]): { readonly fuel: number; readonly maxFuel: number } {
  return {
    fuel: tanks.reduce((sum, t) => sum + t.fuel, 0),
    maxFuel: tanks.reduce((sum, t) => sum + t.maxFuel, 0),
  };
}

// from のタンクを残量がある順に消費し、to のタンクへ空き容量がある順に注ぐことで、
// 複数タンクをまたいだ amountKg [kg] の移送を行う。to が null なら from から失うだけにする。
export function transferRcsFuel(from: Player, to: Player | null, amountKg: number): void {
  const fromTanks = rcsTanksOf(from);
  const available = rcsFuelTotals(fromTanks).fuel;
  const toTransfer = Math.min(amountKg, available);
  if (toTransfer <= 0) return;

  let leftToDrain = toTransfer;
  for (const t of fromTanks) {
    const drain = Math.min(t.fuel, leftToDrain);
    t.fuel -= drain;
    leftToDrain -= drain;
    if (leftToDrain <= 0) break;
  }

  if (!to) return;
  // to 側のタンクへ、空き容量がある順に注ぎ込む。
  let leftToAdd = toTransfer;
  for (const t of rcsTanksOf(to)) {
    const space = t.maxFuel - t.fuel;
    const add = Math.min(space, leftToAdd);
    t.fuel += add;
    leftToAdd -= add;
    if (leftToAdd <= 0) break;
  }
}

// 両者の RCS 燃料を合算し、双方が同じ充填率になるよう再配分する。
export function balanceRcsFuel(shipA: Player, shipB: Player): void {
  const tanksA = rcsTanksOf(shipA);
  const tanksB = rcsTanksOf(shipB);
  const totalFuel = rcsFuelTotals(tanksA).fuel + rcsFuelTotals(tanksB).fuel;
  const totalMax = rcsFuelTotals(tanksA).maxFuel + rcsFuelTotals(tanksB).maxFuel;
  if (totalMax <= 0) return;

  const ratio = totalFuel / totalMax;
  for (const t of tanksA) t.fuel = t.maxFuel * ratio;
  for (const t of tanksB) t.fuel = t.maxFuel * ratio;
}
