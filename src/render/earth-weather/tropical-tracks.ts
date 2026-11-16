// 気圧へ書き込む熱帯低気圧の配置を、時刻の閉じた関数で答える。暖かい海に海域の発生頻度の
// 重みで生まれ、貿易風に流されて西へ走って衰えるか、転向して温帯低気圧へ変わって消える —
// 同時に存在する数は 0 から複数までばらつく。一生は(枡, 世代)ごとの乱数で決まり、どの時刻へ
// 飛んでも同じ配置になる。
import * as THREE from 'three/webgpu';
import { mulberry32, randSym } from '../../math/random';
import { vortexSpinOf } from './wind-law';
import { FEATURE_REACH } from './pressure-feature';
import { courseAt, DAY, DEGREE, uniformIn, waypoint } from './tracks';
import type { Course, PressurePlacement, Range } from './tracks';

// 熱帯低気圧。同時に持つ枡の数。枡は上層の波へ錨づかない — 熱帯の渦は亜熱帯高気圧の縁の
// 操縦流が運ぶもので、位相のずれた枡がそれぞれに生まれ直すだけの別の系である。
export const TROPICAL_COUNT = 5;
// 1 つの枡が候補を立て直す周期 [s]、寿命の幅 [s]、世代ごとの発生率。同時存在の平均は
// 枡数 × 発生率 × 平均寿命 ÷ 周期 = 5 × 0.84 × 8.5 ÷ 21 ≈ 1.7 個で、気候統計(全球 ~85 個/年・
// 平均寿命 ~7 日からの ~1.6)に合わせる。枡ごとの「居る率」π ≈ 0.34 として、全部の枡が空の
// 時刻の割合は (1 − π)⁵ ≈ 0.13、3 つ以上並ぶ割合は ~0.2 — 全球に 1 つも居ない期間と、海域を
// またいで複数並ぶ期間の両方が出る。生まれる時刻は周期の中の一様 — 深さは一生の両端で 0 に
// 降りるので、同じ枡で代が続いても谷は跳ばない。
const TROPICAL_PERIOD = 21 * DAY;
const TROPICAL_LIFETIME: Range = [7 * DAY, 10 * DAY];
const TROPICAL_GENESIS_PROBABILITY = 0.84;
// 乱数の種に足す塩と、枡どうしの隔たり。種は 塩 + 枡 × 隔たり + 世代 で、各枡に 2¹⁶ 世代
// (~3800 年)ぶんの帯を取る。帯の終わり(2²⁰ + 5 × 2¹⁶)は高気圧の塩(2²¹)へ届かず、
// 低気圧の種(世代 × LOW_COUNT + 番号、家族の塩 2²⁴)とも数千年ぶんの進みでは交差しない。
const TROPICAL_SEED_SALT = 1 << 20;
const TROPICAL_SEED_STRIDE = 1 << 16;
// 進路の揺れ [°](±): 生まれる点の緯度・経度、道のり半ばの点の緯度・経度、消える点の緯度・
// 経度。転向の位置も生まれる位置も毎回違い、同じ海域でも同じ進路をなぞらない。
const TROPICAL_BIRTH_LATITUDE_JITTER = 3;
const TROPICAL_BIRTH_LONGITUDE_JITTER = 8;
const TROPICAL_TURN_LATITUDE_JITTER = 3;
const TROPICAL_TURN_LONGITUDE_JITTER = 5;
const TROPICAL_END_LATITUDE_JITTER = 4;
const TROPICAL_END_LONGITUDE_JITTER = 8;
// 最深の幅 [hPa] と生まれる半径の幅 [m]。**眼を持つ範囲で取る** — 最深 55 hPa・半径 240 km でも、
// 転向の直後の最盛期(緯度 13° 以上)で芯の風が等圧線を横切る角は 12° 以下で、眼が全開になる
// 門(12°)より閉じている。温帯化して深さが 6 割・半径が 1.5 倍を超えると 21° 以上に開き、眼が
// 消える門(16°)を越える。
const TROPICAL_DEPTH: Range = [55, 70];
const TROPICAL_BIRTH_RADIUS: Range = [180e3, 240e3];
// 温帯化。半径が増える割合の幅と、行き着く長軸/短軸の比の幅。それぞれ life が onset を過ぎて
// から smoothstep で立ち上がり、消えるときに行き着く — 転向のあと渦は緩く大きくなりながら
// 浅くなり、前線の向きへ伸びた楕円になる。直進する進路は温帯化しない — 前線の向きへは伸びず、
// 衰えるあいだに風の域が広がる(冷水域・陸上で回転が緩む渦は緩く肥大する)分だけ半径が増える
// — 眼はその広がりと浅まりで失う。
const TROPICAL_GROWTH: Range = [2.5, 3.5];
const TROPICAL_STRAIGHT_GROWTH: Range = [0.6, 1.0];
const TROPICAL_GROWTH_ONSET = 0.55;
const TROPICAL_FINAL_ELONGATION: Range = [1.4, 1.8];
const TROPICAL_ELONGATION_ONSET = 0.6;
// 深さの山の偏り。深さ = 最深 × sin(π × life^偏り) で、最盛期が転向(life 0.5)の直後 0.56 に来る。
const TROPICAL_PEAK_SKEW = 1.2;
// 転向した進路の閉塞の進み。温帯化(肥大・伸長)が立ち上がってから、消えるころに追いつき切る。
const TROPICAL_OCCLUSION_ONSET = 0.62;
const TROPICAL_OCCLUSION_FULL = 0.95;

// 海域。発生の重みは気候統計の年間発生数(IBTrACS 1981–2010、熱帯暴風以上で全球 ~85 個/年)
// の相対頻度 — 西太平洋が最多、北インド洋が最少。進路の型は 2 つ: 貿易風に流されて西へ走り
// 続けて陸上か冷水域で衰える直進型 straight と、亜熱帯高気圧の縁を回って中緯度へ抜ける
// 転向型 recurving(こちらだけ温帯化する)。転向する割合 recurvature は海域で違う —
// 東太平洋や北インド洋ではほぼ転向しない。
interface TropicalBasin {
  readonly weight: number; // 年間発生数の相対頻度 [個/年]
  readonly straight: Course;
  readonly recurving: Course;
  readonly recurvature: number;
}

// 海域ごとの発生点と進路 [°]。経度は連続な数で持ち、180° をまたぐ進路は 180 を超える値で書く。
// どの発生点も暖かい海上(平年の雲量の高い海域)に取り、揺れても陸へ出ない幅に抑える。
const TROPICAL_BASINS: readonly TropicalBasin[] = [
  // 西北太平洋(台風) — 全球の発生の約 1/3。直進はフィリピン〜南シナ海へ上陸、転向は日本の
  // 東へ抜ける。
  { weight: 25.0, recurvature: 0.55,
    straight: { origin: waypoint(12, 145), turn: waypoint(16, 128), terminus: waypoint(20, 110) },
    recurving: { origin: waypoint(12, 152), turn: waypoint(22, 134), terminus: waypoint(40, 155) } },
  // 東太平洋(ハリケーン) — ほぼ転向せず西へ走り、冷たい海の上で衰える。まれな転向は
  // 北アメリカ西岸へ回り込む。
  { weight: 16.5, recurvature: 0.15,
    straight: { origin: waypoint(13, -105), turn: waypoint(17, -125), terminus: waypoint(22, -147) },
    recurving: { origin: waypoint(13, -103), turn: waypoint(20, -113), terminus: waypoint(32, -95) } },
  // 北大西洋(ハリケーン) — 直進はカリブ〜メキシコ湾へ上陸、転向は沖合で北東へ抜ける。
  { weight: 12.1, recurvature: 0.6,
    straight: { origin: waypoint(12, -42), turn: waypoint(16, -66), terminus: waypoint(22, -88) },
    recurving: { origin: waypoint(12, -40), turn: waypoint(24, -62), terminus: waypoint(40, -40) } },
  // 南インド洋 — 直進はマダガスカルへ、転向は東を回って南東へ抜ける。
  { weight: 8.4, recurvature: 0.4,
    straight: { origin: waypoint(-12, 88), turn: waypoint(-16, 70), terminus: waypoint(-20, 52) },
    recurving: { origin: waypoint(-12, 85), turn: waypoint(-20, 62), terminus: waypoint(-35, 78) } },
  // 豪州〜南太平洋 — 直進は珊瑚海〜クイーンズランドへ上陸、転向は日付変更線を越えて南東へ。
  { weight: 8.0, recurvature: 0.45,
    straight: { origin: waypoint(-12, 168), turn: waypoint(-17, 152), terminus: waypoint(-23, 138) },
    recurving: { origin: waypoint(-12, 170), turn: waypoint(-22, 158), terminus: waypoint(-35, 190) } },
  // 北インド洋 — 最少でほぼ転向しない。ベンガル湾の奥〜インドへ上陸して衰える。
  { weight: 3.9, recurvature: 0.2,
    straight: { origin: waypoint(13, 88), turn: waypoint(18, 83), terminus: waypoint(23, 78) },
    recurving: { origin: waypoint(11, 85), turn: waypoint(18, 90), terminus: waypoint(26, 98) } },
];

// 海域の重みの合計 [個/年]。
const TROPICAL_BASIN_TOTAL = TROPICAL_BASINS.reduce((sum, basin) => sum + basin.weight, 0);

// rand([0, 1) の生成器)から海域を発生頻度の重みで引く。
function tropicalBasinAt(rand: () => number): TropicalBasin {
  let draw = rand() * TROPICAL_BASIN_TOTAL;
  for (const basin of TROPICAL_BASINS) {
    draw -= basin.weight;
    if (draw < 0) return basin;
  }
  return TROPICAL_BASINS[TROPICAL_BASINS.length - 1]!;
}

// 熱帯低気圧 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、進路
// course、最深 peakDepth [hPa]、生まれる半径 birthRadius [m]、半径が増える割合 growth(転向は
// 温帯化、直進は衰えの広がり)と行き着く長軸/短軸の比 finalElongation(直進する進路では 1)。
interface TropicalTrack {
  readonly onset: number;
  readonly lifetime: number;
  readonly course: Course;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
  readonly finalElongation: number;
  readonly recurving: boolean;
}

// 枡 index に世代 generation で生まれる熱帯低気圧の一生。その世代に発生しないなら null —
// 空の世代が全球の 0 個期間を作る。乱数は(枡, 世代)ごとに 1 列で、引く順が一生を決める
// — 時刻の閉じた関数のまま保つ。海域は年間発生数の比で、進路の型は海域の転向率で引く。
function tropicalTrackOf(index: number, generation: number): TropicalTrack | null {
  const rand = mulberry32(TROPICAL_SEED_SALT + index * TROPICAL_SEED_STRIDE + generation);
  if (rand() >= TROPICAL_GENESIS_PROBABILITY) return null;
  const lifetime = uniformIn(TROPICAL_LIFETIME, rand);
  const onset = rand() * (TROPICAL_PERIOD - lifetime);
  const basin = tropicalBasinAt(rand);
  const recurving = rand() < basin.recurvature;
  const base = recurving ? basin.recurving : basin.straight;
  // 海域の進路を、生まれる点・道のり半ばの点・消える点の順に揺らす。
  const birthLatitude = base.origin.latitude + randSym(TROPICAL_BIRTH_LATITUDE_JITTER, rand);
  const birthLongitude = base.origin.longitude + randSym(TROPICAL_BIRTH_LONGITUDE_JITTER, rand);
  const turnLatitude = base.turn.latitude + randSym(TROPICAL_TURN_LATITUDE_JITTER, rand);
  const turnLongitude = base.turn.longitude + randSym(TROPICAL_TURN_LONGITUDE_JITTER, rand);
  const endLatitude = base.terminus.latitude + randSym(TROPICAL_END_LATITUDE_JITTER, rand);
  const endLongitude = base.terminus.longitude + randSym(TROPICAL_END_LONGITUDE_JITTER, rand);
  // 強さと温帯化の様子。温帯化(肥大と伸長)は転向する進路だけ — 直進する渦は衰えながら
  // 少し広がるだけで、前線の向きへは伸びない。
  const peakDepth = uniformIn(TROPICAL_DEPTH, rand);
  const birthRadius = uniformIn(TROPICAL_BIRTH_RADIUS, rand);
  const growth = recurving ? uniformIn(TROPICAL_GROWTH, rand) : uniformIn(TROPICAL_STRAIGHT_GROWTH, rand);
  const finalElongation = recurving ? uniformIn(TROPICAL_FINAL_ELONGATION, rand) : 1;
  const course = {
    origin: waypoint(birthLatitude, birthLongitude),
    turn: waypoint(turnLatitude, turnLongitude),
    terminus: waypoint(endLatitude, endLongitude),
  };
  return { onset, lifetime, course, peakDepth, birthRadius, growth, finalElongation, recurving };
}

// 積算の巻き上げ角 [rad]。生まれてからの、谷の循環が気団の境目を巻き上げてきた総量。
// 転向して温帯化する渦は肥大・浅化で循環が緩むので、積算は一生の深さ・半径・緯度を辿る。
const WOUND_STEPS = 16;
function tropicalWoundOf(track: TropicalTrack, life: number, rotationPeriod: number): number {
  let sum = 0;
  for (let i = 0; i <= WOUND_STEPS; i += 1) {
    const l = (life * i) / WOUND_STEPS;
    const spin = vortexSpinOf(
      track.peakDepth * Math.sin(Math.PI * l ** TROPICAL_PEAK_SKEW),
      track.birthRadius
        * (1 + track.growth * THREE.MathUtils.smoothstep(l, TROPICAL_GROWTH_ONSET, 1)),
      courseAt(track.course, l).latitude * DEGREE,
      FEATURE_REACH, rotationPeriod,
    );
    sum += (i === 0 || i === WOUND_STEPS ? 0.5 : 1) * spin.coreOmega;
  }
  return (sum * life * track.lifetime) / WOUND_STEPS;
}

// 熱帯低気圧 index(0..TROPICAL_COUNT − 1)の、時刻 seconds [s] における配置。その世代に
// 発生しない、生まれる前、消えたあとは null。rotationPeriod [s] は自転周期。
export function tropicalPlacementAt(
  index: number, seconds: number, rotationPeriod: number,
): PressurePlacement | null {
  // 枡ごとに周期の位相をずらし、揃って生まれ直さないようにする。
  const age = seconds / TROPICAL_PERIOD + index / TROPICAL_COUNT;
  const generation = Math.floor(age);
  const track = tropicalTrackOf(index, generation);
  if (track === null) return null;
  const life = ((age - generation) * TROPICAL_PERIOD - track.onset) / track.lifetime;
  if (life < 0 || life > 1) return null;
  // 進路を等速で辿り、転向した進路はそのあと緩く大きくなりながら浅くなり、前線の向きへ伸びる。
  const point = courseAt(track.course, life);
  return {
    latitude: point.latitude * DEGREE,
    longitude: point.longitude * DEGREE,
    depth: track.peakDepth * Math.sin(Math.PI * life ** TROPICAL_PEAK_SKEW),
    radius: track.birthRadius * (1 + track.growth * THREE.MathUtils.smoothstep(life, TROPICAL_GROWTH_ONSET, 1)),
    elongation: 1 + (track.finalElongation - 1) * THREE.MathUtils.smoothstep(life, TROPICAL_ELONGATION_ONSET, 1),
    // 転向した進路は温帯化とともに閉塞し、赤道側の尾は寒冷・温暖の対へ育つ。
    occlusion: track.recurving
      ? THREE.MathUtils.smoothstep(life, TROPICAL_OCCLUSION_ONSET, TROPICAL_OCCLUSION_FULL)
      : undefined,
    fronts: 'tail',
    wound: tropicalWoundOf(track, life, rotationPeriod),
  };
}
