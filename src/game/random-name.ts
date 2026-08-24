// 船艇・基地・敵機等の未指定時デフォルト命名ジェネレータ。
// ポリネシア語（航海・星・自然）、広東語（星海・勇猛・天空）、フランス語（天体・要塞・航海）の
// 単語群からランダムに選定し、ランダムな識別番号(10〜99)を付与する。

export type EntityCategory = 'player' | 'base' | 'enemy' | 'ammo' | 'fuel';

const POLYNESIAN_SHIPS = [
  'Moana', 'Matariki', 'Matangi', 'Kapehu', 'Hoku', 'Mahina', 'Tawhiri', 'Nalu', 'Waka', 'Moerani', 'Aotearoa',
];
const POLYNESIAN_BASES = [
  'Pa-Station', 'Puuhonua', 'Henua', 'Marae', 'Kainga', 'Whare',
];
const POLYNESIAN_ENEMIES = [
  'Taniwha', 'Tipua', 'Tupua', 'Karakia',
];

const CANTONESE_SHIPS = [
  'Tin-Gong', 'Fei-Lung', 'Sing-Hoi', 'Loi-Gong', 'Fung-Wong', 'Bakk-Dou', 'Kiu-Lung', 'Zing-Fuk',
];
const CANTONESE_BASES = [
  'Sing-Zan', 'Tin-Gong-Port', 'Daid-Wai', 'Saam-Baa', 'Gong-Au',
];
const CANTONESE_ENEMIES = [
  'Hek-Sei', 'Ma-Lau', 'Haq-Wai', 'Zek-Wong',
];

const FRENCH_SHIPS = [
  'Astrolabe', 'L-Etoile', 'Boree', 'L-Epervier', 'Celeste', 'Courageux', 'L-Aventuriere', 'Albatros',
];
const FRENCH_BASES = [
  'Bastion', 'Citadelle', 'L-Aurore', 'Sanctuaire', 'L-Hermitage', 'Observatoire',
];
const FRENCH_ENEMIES = [
  'Corsaire', 'Loup-de-Mer', 'Faucon', 'Vautour',
];

// 均等確率でポリネシア語(0)・広東語(1)・フランス語(2)のプールを選択し、単語+2桁番号を返す
export function generateRandomName(category: EntityCategory): string {
  if (category === 'ammo' || category === 'fuel') {
    const num = Math.floor(Math.random() * 90) + 10;
    return `${category === 'fuel' ? 'RCS-Fuel' : 'Ammo'}-${num}`;
  }

  const lang = Math.floor(Math.random() * 3);
  let pool: readonly string[];

  if (lang === 0) {
    pool = category === 'player' ? POLYNESIAN_SHIPS : category === 'base' ? POLYNESIAN_BASES : POLYNESIAN_ENEMIES;
  } else if (lang === 1) {
    pool = category === 'player' ? CANTONESE_SHIPS : category === 'base' ? CANTONESE_BASES : CANTONESE_ENEMIES;
  } else {
    pool = category === 'player' ? FRENCH_SHIPS : category === 'base' ? FRENCH_BASES : FRENCH_ENEMIES;
  }

  const baseWord = pool[Math.floor(Math.random() * pool.length)]!;
  const num = Math.floor(Math.random() * 90) + 10;
  return `${baseWord}-${num}`;
}
