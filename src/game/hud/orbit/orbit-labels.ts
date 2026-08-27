// 軌道要素(近点/遠点, 昇降点/赤道交点, 傾斜角, 周期等)の略称(マーカー用)・日本語名・英語正式名・プロパティウィンドウ用完全名の定義とフォーマッタ。

export interface OrbitLabelSpec {
  readonly short: string;  // マーカー用略称 (例: "Pe", "Ap")
  readonly nameJa: string; // 日本語名 (例: "近地点", "近月点")
  readonly nameEn: string; // 英語正式名 (例: "Perigee", "Perilune")
  readonly full: string;   // プロパティウィンドウ用 (例: "近地点 Perigee", "近月点 Perilune")
}

// 中心天体の ID (earth, moon, sun 等) に応じた近点 (Pe) / 遠点 (Ap) のラベル仕様を取得する
export function getApsisLabelSpec(type: 'pe' | 'ap', centerId: string): OrbitLabelSpec {
  const isEarth = centerId === 'earth';
  const isMoon = centerId === 'moon';
  const isSun = centerId === 'sun';

  if (type === 'pe') {
    // 近点のラベル。
    if (isEarth) return { short: 'Pe', nameJa: '近地点', nameEn: 'Perigee', full: '近地点 Perigee' };
    if (isMoon)  return { short: 'Pe', nameJa: '近月点', nameEn: 'Perilune', full: '近月点 Perilune' };
    if (isSun)   return { short: 'Pe', nameJa: '近日点', nameEn: 'Perihelion', full: '近日点 Perihelion' };
    return { short: 'Pe', nameJa: '近点', nameEn: 'Periapsis', full: '近点 Periapsis' };
  } else {
    // 遠点のラベル。
    if (isEarth) return { short: 'Ap', nameJa: '遠地点', nameEn: 'Apogee', full: '遠地点 Apogee' };
    if (isMoon)  return { short: 'Ap', nameJa: '遠月点', nameEn: 'Apolune', full: '遠月点 Apolune' };
    if (isSun)   return { short: 'Ap', nameJa: '遠日点', nameEn: 'Aphelion', full: '遠日点 Aphelion' };
    return { short: 'Ap', nameJa: '遠点', nameEn: 'Apoapsis', full: '遠点 Apoapsis' };
  }
}

// 定型的な軌道要素ラベルの定義 (交点・傾斜角・周期・高度・速度)
export const ORBIT_ELEMENT_LABELS = {
  an: { short: 'AN', nameJa: '昇交点', nameEn: 'Ascending Node', full: '昇交点 Ascending Node' },
  dn: { short: 'DN', nameJa: '降交点', nameEn: 'Descending Node', full: '降交点 Descending Node' },
  ca: { short: '再接近', nameJa: '再接近点', nameEn: 'Closest Approach', full: '再接近点 Closest Approach' },
  eqAn: { short: 'EqAN', nameJa: '赤道昇交点', nameEn: 'Equatorial Ascending Node', full: '赤道昇交点 Equatorial Ascending Node' },
  eqDn: { short: 'EqDN', nameJa: '赤道降交点', nameEn: 'Equatorial Descending Node', full: '赤道降交点 Equatorial Descending Node' },
  inc: { short: 'INC', nameJa: '傾斜角', nameEn: 'Inclination', full: '傾斜角 Inclination' },
  prd: { short: 'PRD', nameJa: '周期', nameEn: 'Period', full: '周期 Period' },
  spd: { short: 'SPD', nameJa: '速度', nameEn: 'Speed', full: '速度 Speed' },
  alt: { short: 'ALT', nameJa: '高度', nameEn: 'Altitude', full: '高度 Altitude' },
} as const;
