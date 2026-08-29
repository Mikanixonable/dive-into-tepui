// 天体1体の見た目側の静的事実のうち、THREE に依存しない型。tests が node で実行する
// モジュール(system-membership 等)はここから型だけを引く。
import type { CelestialKind } from '../../../physics/celestial-motion';

// 天体の表示上の重要度。運動の kind(恒星/惑星/衛星)が「中心天体が何か」という
// 力学上の分類であるのに対し、こちらは「マップで既定でも見せるか、絞り込みの対象にするか」
// という編集上の判断で、同じ kind: 'planet' の中から準惑星・小天体を分ける。
export type CelestialClass = 'star' | 'planet' | 'dwarf' | 'satellite' | 'smallBody';

// 力学上の分類だけから決める表示クラス。準惑星・小天体の区別が付かないので、惑星と衛星と
// 恒星の3つにしか落ちない(架空天体の既定)。
export function celestialClassOfKind(kind: CelestialKind): CelestialClass {
  return kind === 'star' ? 'star' : kind === 'satellite' ? 'satellite' : 'planet';
}
