// 気圧へ書き込む中緯度の低気圧の谷の配置を、時刻の閉じた関数で答える。上層のロスビー波の
// 谷の下流側、蛇行の振幅の強いストームトラックの海域に生まれ、波とともに東へ運ばれて
// トラックの終端で埋まる。進路と一生は(枡, 世代)ごとの乱数で決まり、どの時刻へ飛んでも
// 同じ配置になる。
import * as THREE from 'three/webgpu';
import { mulberry32, randSym } from '../../math/random';
import {
  WAVE_DRIFT, WAVE_TROUGH_WIDTH, stormTrackAxisAt, waveAmplitudeAt, waveAnchoredSlot,
  waveTroughLongitude,
} from './rossby-wave';
import { courseAt, DAY, DEGREE, uniformIn, waypoint } from './tracks';
import type { Course, PressurePlacement, Range } from './tracks';

// 中緯度の低気圧。同時に持つ枡の数(偶数番が北、奇数番が南)。枡は上層のロスビー波の谷へ
// 錨づき、半球あたりの枡の数は谷の数(WAVE_NUMBER)より多い — 世代ごとに同じ谷へ複数の枡が
// 並び、発生の門を通った世代にはトラックの下流へ低気圧が連なる。
export const LOW_COUNT = 32;
// 1 つの枡が候補を立て直す周期 [s] と寿命の幅 [s]。寿命は周期より短く、生まれる時刻を周期の中で
// 揺らす余地(周期 − 寿命)を残す — 同じ枡の低気圧が毎回同じ間隔で現れない。同じ枡で前の低気圧が
// 消えてから次が生まれるまでに必ず空く時間 [s] を、その余地の両端から取る — 深さ 0 の谷が
// 入れ替わる瞬間に中心が極側の東端から亜熱帯の西端へ移るので、居ない時間を挟んで 1 つの谷が
// 跳んだと読めなくする。寿命は区間比の冪(幾何一様)で右裾に引く — 中央値が √(min·max) ≈ 4.5 日、
// 短い系が多く 10 日に届くものはまれ(気候統計: 中央値 ~4.5 日、幅 2〜10 日)。
const LOW_PERIOD = 11 * DAY;
const LOW_LIFETIME: Range = [2 * DAY, 10 * DAY];
const LOW_REBIRTH_GAP = 6 * 3600;
// 家族の後続(2 次低気圧)が、一次の低気圧が埋まってから立つまでの間 [s] とその揺れの幅 [s]。
// 深さが 0 へ降りてから中心が動くので、候補の交代で谷が跳んで見えることはない — 間は時間の
// 刻み(1 時間)より長く取り、どの観測の刻みでも交代のあいだの不在が必ず見える幅にする。
// 後続は周期の残りに一生が収まるときだけ生まれる。
const LOW_HANDOFF_GAP = 3 * 3600;
const LOW_HANDOFF_JITTER = 3 * 3600;
// 生まれる緯度の幅 [°]。亜熱帯の縁に生まれる
// (`DEVELOP/SPEC/RENDERING.md`「中緯度の低気圧は生まれ、東へ走り、極側で止まって消える」)。
const LOW_BIRTH_LATITUDE: Range = [32, 45];
// 枡の経度は上層のロスビー波の谷へ錨づく — 地表の低気圧は上層の谷の下流側で発達する。
// 谷からの下流への距離 [°]、同じ谷へ並ぶ枡どうしの下流方向の間隔 [°]、生まれる経度の
// 揺れ(谷の間隔 WAVE_TROUGH_WIDTH に対する比、±)。間隔でずらすので、同じ谷から生まれた
// 低気圧は重ならずにトラックへ連なる。
const WAVE_LOW_DOWNSTREAM = 25;
const LOW_RANK_SPACING = 20;
const LOW_LONGITUDE_JITTER = 0.08;
// 発生の門。生まれる点での蛇行振幅(緯度包絡 × ストームトラック重み)がこの門を超えたときだけ
// 低気圧が立つ — 谷がトラックの海域を通る世代だけ発生するので、発生は海域へ偏り、位相の外れた
// 時期は半球じゅうで低気圧が減る。南半球は帯が広く重なり振幅の経度差が小さいので、門を高く
// 取って同じくらいの選択率に揃える。門の揺れ(±の比)で、門の境目の出入りを硬くしない。
const LOW_GENESIS_AMPLITUDE_NORTH = 0.45;
const LOW_GENESIS_AMPLITUDE_SOUTH = 0.68;
const LOW_GATE_JITTER = 0.15;
// 家族(2 次低気圧)。一次の低気圧が立った世代のうち、より強い振幅の門を超えた所で、この確率の
// 後続を周期の残りへ立てる — 群発日の増分の約半分を 2 次低気圧が担うという観測へ寄せる。
const LOW_FAMILY_AMPLITUDE = 0.65;
const LOW_FAMILY_PROBABILITY = 0.45;
// 同じ半球の谷へ近づきすぎた谷は吸収される — 深い低気圧が浅い低気圧を呑む。
// 浅い側の深さを、半径の和に対する距離の近さで削る幅。半径の和へ届く前に浅い側の深さが
// ほぼ 0 になるよう、和の 2 倍から削り始めて 0.95 倍で消える形に取る — 近づく速さで深さの
// 変化が急にならないよう、帯の幅は千 km 級に保つ。吸収する側・される側は最深(一生の山)で
// 決める — 瞬間の深さで決めると、追いついた 2 つの深さが入れ替わる瞬間に浅い側の深さが
// 不連続に跳ぶ。
const ABSORB_FADE_START = 2.0;
const ABSORB_FADE_FULL = 0.95;
// 吸収の効きを見る時間窓の半幅 [s] と刻み [s]。相手の配置を前後 ±窓 で標本化して最強の効きを
// 取る — 相手が生まれても埋まっても、近い時刻が窓へ出入りするあいだ効きは ~1 日かけて逓増・
// 逓減するので、浅い側の深さが相手の消滅と同時に跳んで戻らない。
const ABSORB_WINDOW = 24 * 3600;
const ABSORB_WINDOW_STEP = 3 * 3600;
// 窓の半幅に入る刻みの数。
const ABSORB_WINDOW_STEPS = Math.round(ABSORB_WINDOW / ABSORB_WINDOW_STEP);
// 窓の標本の効きをなめらかな最大でたたむ鋭さ。大きいほど本物の最大に近づく — 小さすぎると
// 弱い標本の寄与が積み上がって遠くの相手でも浅い側を沈めてしまう。標本の入れ替わり(argmax
// の跳び)がそのまま深さの勾配の跳びになるので、隣り合う標本どうしを混ぜる程度に取る。
const ABSORB_SOFTMAX = 12;
// 標本ごとの「居る度」が生まれと消えの両端で 0→1 になるまでの時間 [s]。深さで見ると呑む側が
// 埋まる速さで効きが抜けるので、一生の両端への時間で見る — 寿命によらず一定の勾配になる。
const ABSORB_LIFE_RAMP = 12 * 3600;
// 標本ごとの効きが全強度になる、呑む側の深さ [hPa]。居る度がまだ低い生まれたて・消えかけの
// 低気圧でも、深さがこれ以上あれば半径の和の内側の浅い側を沈め切れる。深さへの立ち上がりを
// 緩く取る — 浅い門にすると、発達の速い低気圧が近くへ現れたときに効きがその発達の速さで立つ。
const ABSORB_FADE_DEPTH = 10;
// 一生を平均した自力の速さの幅 [m/s]、南半球の倍率、減速の指数の幅。速さも区間比の冪で右裾に
// 引く — 速いものほど珍しい。波ドリフト(緯度 40° で ~3 m/s)を足して、平均の東進はおおよそ
// 10〜15 m/s(南半球はやや速く 12〜18)に乗る。道のりの進みは 1 − (1 − life)^指数 で、
// 消えるときに止まる — 若いうち速く、発達しきると足を緩める。
const LOW_SPEED: Range = [6.5, 11];
const LOW_SH_SPEED = 1.15;
const LOW_BRAKE: Range = [1.5, 2.0];
// 折れ曲がり点での極側への進みの割合の揺れ(±)。
const LOW_TURN_JITTER = 0.05;
// 最深の最小値と幅 [hPa]。u² で右裾に引く — 弱い系が多く、深い爆弾低気圧はまれ。
const LOW_DEPTH_MIN = 12;
const LOW_DEPTH_SPAN = 28;
// 生まれる半径の幅 [m]、深い系ほど広く取る下限を支える深さ [hPa]、半径の上限 [m]。
// **眼を持たない範囲で取る** — 半径を √(最深 / この深さ) 倍へ下から支えるので、最深 40 hPa でも
// 芯で風が等圧線を横切る角は眼の開く門(16°)より開いている。上限は谷の裾野の影響限界
// (消えるとき短軸 1800 km)を越えないよう抑える。
const LOW_BIRTH_RADIUS: Range = [550e3, 850e3];
const LOW_DEEP_RADIUS = 28;
const LOW_RADIUS_MAX = 900e3;
const LOW_GROWTH: Range = [0.5, 1.0];
// 深さの山の偏り。深さ = 最深 × sin(π × life^偏り) で、最盛期が life 0.42 へ寄る。
const LOW_PEAK_SKEW = 0.8;
// 閉塞が始まり、追いつき切るまでの一生の中の位置。深さの山(life 0.42)を越えてから寒冷前線が
// 温暖前線へ追いつき始め、一生の 3/4 までに暖域の舌が芯から切り離される。
const LOW_OCCLUSION_ONSET = 0.45;
const LOW_OCCLUSION_FULL = 0.75;
// 生まれてから深さの山が立ち始めるまでの時間 [s]。山の式は生まれた直後の傾きが発散するので、
// 発達はこの時間かけて立ち上げる — 短い一生で深い系がいきなり 1 時間に数 hPa 深くならない。
const LOW_DEPTH_RAMP = 18 * 3600;
// 長軸/短軸の比。前線の向きへ伸びた楕円。
const LOW_ELONGATION = 1.3;
// 乱数の種に足す塩。一次の種(世代 × LOW_COUNT + 番号)がここへ届くのに ~1.6 万年かかる先に
// 取る(2²⁴ ÷ LOW_COUNT 世代 × 周期 11 日)。種どうしの交差が先に起きる時点 — 一次の種が熱帯の
// 帯(2²⁰)へ届く ~987 年 — より十分に遠い。
const LOW_SECONDARY_SEED_SALT = 1 << 24;

// ストームトラックの軸(海域)ごとの、進路の折れ方と消える緯度の帯。北上はトラックの北東
// 傾斜(南半球では南東傾斜)で、傾きは海域ごとに違う — 発生した帯に応じて折れ方を変える。
// 消える緯度はトラックの終端 — 北半球は湾奥や欧州〜高緯度の海、南半球は南極の縁。
interface TrackAxis {
  readonly center: number; // 帯の bump の中心経度 [°]
  readonly endLatitude: Range; // 消える緯度の帯 [°](絶対値)
  readonly turnPoleward: number; // 折れ曲がりの時点での極側への進みの割合
  readonly turnEastward: number; // 折れ曲がりの時点での東への進みの割合
}
const TRACK_AXES: readonly TrackAxis[] = [
  // 北西太平洋 — 強く北東へ折れ、日付変更線〜アラスカ湾で埋まる。
  { center: 140, endLatitude: [55, 65], turnPoleward: 0.45, turnEastward: 0.55 },
  // 北大西洋西岸 — アイスランド〜欧州へ向かう。
  { center: -60, endLatitude: [56, 67], turnPoleward: 0.4, turnEastward: 0.6 },
  // 欧州〜地中海の二次的な帯 — より東向きに進み、シベリア・北欧で埋まる。
  { center: 20, endLatitude: [55, 66], turnPoleward: 0.3, turnEastward: 0.65 },
  // 南大西洋〜南インド洋の広い帯と南西太平洋 — 南極の縁へらせん状に降りる。
  { center: 30, endLatitude: [60, 67], turnPoleward: 0.35, turnEastward: 0.6 },
  { center: 150, endLatitude: [60, 67], turnPoleward: 0.35, turnEastward: 0.6 },
];

// 経度 longitudeDeg [°]・半球 hemisphere (北 +1 / 南 −1) で発生した低気圧が乗るトラックの軸。
// 発生経度へいちばん強い bump の中心を返し、その中心に近い軸の行を引く。
function trackAxisAt(longitudeDeg: number, hemisphere: number): TrackAxis {
  const center = stormTrackAxisAt(longitudeDeg * DEGREE, hemisphere) / DEGREE;
  let nearest = TRACK_AXES[0]!;
  let nearestDistance = Infinity;
  for (const axis of TRACK_AXES) {
    // 軸の中心と bump の中心の、円周上の距離。
    const distance = Math.abs(Math.atan2(
      Math.sin((axis.center - center) * DEGREE), Math.cos((axis.center - center) * DEGREE),
    ));
    if (distance < nearestDistance) {
      nearest = axis;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// 中緯度の低気圧 1 つの一生。周期の頭から生まれるまでの時間 onset [s]、寿命 lifetime [s]、
// 生まれる時刻 birthSeconds [s](波の錨がこの時刻の谷の位相へ置かれる)、進路
// course(緯度は半球の符号を含む)、減速の指数 brake、最深 peakDepth [hPa]、生まれる半径
// birthRadius [m]、消えるまでに半径が増える割合 growth。
interface LowTrack {
  readonly onset: number;
  readonly lifetime: number;
  readonly birthSeconds: number;
  readonly course: Course;
  readonly brake: number;
  readonly peakDepth: number;
  readonly birthRadius: number;
  readonly growth: number;
}

// 枡 index に世代 generation で生まれる低気圧の候補 candidate(0 は一次、1 は家族の後続)。
// 発生を認めないとき(振幅の門を超えない、周期の残りに収まらない)は null。乱数は
// (枡, 世代, 候補) ごとに 1 列で、引く順が一生を決める — 時刻の閉じた関数のまま保つ。
// surfaceRadius [m] は天体の半径で、走る速さ [m/s] を経度の進み [°] へ直すのに要る。
function lowTrackOf(
  index: number, generation: number, candidate: number, surfaceRadius: number,
): LowTrack | null {
  const hemisphere = index % 2 === 0 ? 1 : -1;
  const slot = Math.floor(index / 2);
  const rand = mulberry32(
    generation * LOW_COUNT + index + candidate * LOW_SECONDARY_SEED_SALT,
  );
  const lifetime = LOW_LIFETIME[0] * (LOW_LIFETIME[1] / LOW_LIFETIME[0]) ** rand();
  let onset: number;
  if (candidate === 0) {
    onset = LOW_REBIRTH_GAP / 2 + rand() * (LOW_PERIOD - lifetime - LOW_REBIRTH_GAP);
  } else {
    // 家族の後続は、一次の低気圧が立って埋まったあと、同じ世代の残りにだけ置く。
    const primary = lowTrackOf(index, generation, 0, surfaceRadius);
    if (primary === null) return null;
    onset = primary.onset + primary.lifetime + LOW_HANDOFF_GAP + rand() * LOW_HANDOFF_JITTER;
    if (onset + lifetime + LOW_REBIRTH_GAP / 2 > LOW_PERIOD) return null;
  }
  const birthLatitude = uniformIn(LOW_BIRTH_LATITUDE, rand);
  // この世代で枡が座る波の谷の番号と、同じ谷へ並ぶ枡の中での順番。生まれる時刻 [s] =
  // 世代の周期の頭から onset だけ遅れ、枡の位相ずらし分だけ早い。
  const { index: troughIndex, rank } = waveAnchoredSlot(slot, generation);
  const birthSeconds = (generation - index / LOW_COUNT) * LOW_PERIOD + onset;
  const birthLongitude = waveTroughLongitude(troughIndex, birthSeconds, hemisphere) / DEGREE
    + WAVE_LOW_DOWNSTREAM + rank * LOW_RANK_SPACING
    + randSym(LOW_LONGITUDE_JITTER * WAVE_TROUGH_WIDTH, rand);
  // 発生は生まれる点での蛇行振幅で門をくぐる。一次は通常の門、後続はより強い門と確率の両方。
  // 緯度は半球の符号を付けて渡す — ストームトラックの帯は半球ごとに別の束を持つ。
  const amplitude = waveAmplitudeAt(hemisphere * birthLatitude * DEGREE, birthLongitude * DEGREE);
  if (candidate === 0) {
    const base = hemisphere > 0 ? LOW_GENESIS_AMPLITUDE_NORTH : LOW_GENESIS_AMPLITUDE_SOUTH;
    const gate = base * (1 + randSym(LOW_GATE_JITTER, rand));
    if (amplitude < gate) return null;
  } else if (amplitude < LOW_FAMILY_AMPLITUDE || rand() >= LOW_FAMILY_PROBABILITY) {
    return null;
  }
  // 発生した帯の軸から、折れ方と消える緯度の帯を決める。
  const axis = trackAxisAt(birthLongitude, hemisphere);
  const endLatitude = uniformIn(axis.endLatitude, rand);
  const speed = LOW_SPEED[0] * (LOW_SPEED[1] / LOW_SPEED[0]) ** rand()
    * (hemisphere < 0 ? LOW_SH_SPEED : 1);
  const peakDepth = LOW_DEPTH_MIN + LOW_DEPTH_SPAN * rand() ** 2;
  const birthRadius = Math.min(
    LOW_RADIUS_MAX,
    uniformIn(LOW_BIRTH_RADIUS, rand) * Math.max(1, Math.sqrt(peakDepth / LOW_DEEP_RADIUS)),
  );
  const growth = uniformIn(LOW_GROWTH, rand);
  const brake = uniformIn(LOW_BRAKE, rand);
  // 東への進み [°]: 平均の速さで寿命のあいだ走った道のりを、進路の中ほどの緯度の緯線で測る。
  const poleward = endLatitude - birthLatitude;
  const midLatitude = (birthLatitude + endLatitude) / 2;
  const eastward = (speed * lifetime) / (surfaceRadius * Math.cos(midLatitude * DEGREE)) / DEGREE;
  // 先に東へ走り、あとでトラックの傾きに沿って極側へ折れる。
  const turnPoleward = axis.turnPoleward + randSym(LOW_TURN_JITTER, rand);
  const course = {
    origin: waypoint(hemisphere * birthLatitude, birthLongitude),
    turn: waypoint(
      hemisphere * (birthLatitude + turnPoleward * poleward),
      birthLongitude + axis.turnEastward * eastward,
    ),
    terminus: waypoint(hemisphere * endLatitude, birthLongitude + eastward),
  };
  return { onset, lifetime, birthSeconds, course, brake, peakDepth, birthRadius, growth };
}

// 吸収を考えない生の配置と、その一生の最深 [hPa]。吸収する側・される側の判定は最深で行うので、
// 一生の山を配置と一緒に返す。
interface RawLow {
  readonly placement: PressurePlacement;
  readonly peakDepth: number;
  // 吸収の効きのための「居る度」0〜1。生まれと消えの両端で ABSORB_LIFE_RAMP かけて立ち上がる。
  readonly presence: number;
}

// 中緯度の低気圧 index(0..LOW_COUNT − 1)の、時刻 seconds [s] における配置(吸収を考えない
// 生の値)。同じ時刻に生きている候補は高々 1 つなので、一次から順に最初の生きている候補を返す。
function rawLowPlacementAt(
  index: number, seconds: number, surfaceRadius: number,
): RawLow | null {
  // 枡ごとに周期の位相をずらし、同じ半球の枡が揃って生まれ直さないようにする。
  const age = seconds / LOW_PERIOD + index / LOW_COUNT;
  const generation = Math.floor(age);
  const periodSeconds = (age - generation) * LOW_PERIOD;
  for (let candidate = 0; candidate <= 1; candidate++) {
    const track = lowTrackOf(index, generation, candidate, surfaceRadius);
    if (track === null) continue;
    const life = (periodSeconds - track.onset) / track.lifetime;
    if (life < 0 || life > 1) continue;
    const point = courseAt(track.course, 1 - (1 - life) ** track.brake);
    return {
      placement: {
        latitude: point.latitude * DEGREE,
        // 錨は波とともに東へ進む — 生まれた時刻からのドリフトを進路へ足す。
        longitude: (point.longitude + WAVE_DRIFT * (seconds - track.birthSeconds)) * DEGREE,
        depth: track.peakDepth * Math.sin(Math.PI * life ** LOW_PEAK_SKEW)
          * THREE.MathUtils.smoothstep(life * track.lifetime, 0, LOW_DEPTH_RAMP),
        radius: track.birthRadius * (1 + track.growth * life),
        elongation: LOW_ELONGATION,
        occlusion: THREE.MathUtils.smoothstep(life, LOW_OCCLUSION_ONSET, LOW_OCCLUSION_FULL),
        fronts: 'pair',
        life,
      },
      peakDepth: track.peakDepth,
      presence: Math.min(1, Math.min(life, 1 - life) * track.lifetime / ABSORB_LIFE_RAMP),
    };
  }
  return null;
}

// 中緯度の低気圧 index(0..LOW_COUNT − 1)の、時刻 seconds [s] における配置。surfaceRadius [m] は
// 天体の半径。生まれる前と消えたあとは null。
export function lowPlacementAt(
  index: number, seconds: number, surfaceRadius: number,
): PressurePlacement | null {
  return absorbedLowAt(
    index, surfaceRadius,
    (j, k) => rawLowPlacementAt(j, seconds + k * ABSORB_WINDOW_STEP, surfaceRadius),
  );
}

// 中緯度の低気圧 LOW_COUNT 個全部の、時刻 seconds [s] における配置。戻り値の index 番目は
// lowPlacementAt(index, seconds, surfaceRadius) と同じ。吸収の効きは同じ半球の全枡の生の配置を
// ±窓 で標本化した上で決まるので、全枡・全刻みの生の配置を先に表へ起こして分け合う — 1 枡ずつ
// 引くと同じ生の配置を相手ごと・刻みごとに組み直すことになる。
export function lowPlacementsAt(
  seconds: number, surfaceRadius: number,
): readonly (PressurePlacement | null)[] {
  // 生の配置の表 [枡][窓の標本]。標本は時刻から −窓 側が先頭。
  const raw = Array.from({ length: LOW_COUNT }, (_, j) =>
    Array.from({ length: 2 * ABSORB_WINDOW_STEPS + 1 }, (_, k) =>
      rawLowPlacementAt(j, seconds + (k - ABSORB_WINDOW_STEPS) * ABSORB_WINDOW_STEP, surfaceRadius)));
  return Array.from({ length: LOW_COUNT }, (_, index) =>
    absorbedLowAt(index, surfaceRadius, (j, k) => raw[j]![k + ABSORB_WINDOW_STEPS]!));
}

// 中緯度の低気圧 index の、吸収込みの配置。rawAt(j, k) は枡 j の時刻 +k 刻み(0 が現在)の
// 生の配置を返す — 生の配置をその場で組むか表から引くかは呼び出し側が決める。生まれる前と
// 消えたあとは null。
function absorbedLowAt(
  index: number, surfaceRadius: number,
  rawAt: (index: number, offset: number) => RawLow | null,
): PressurePlacement | null {
  const self = rawAt(index, 0);
  if (self === null) return null;
  // 吸収 — 同じ半球で、自分より最深の深い谷へ半径の和の 2 倍より近づいた谷は、近さに応じて
  // 深さを削る。対の評価はどちらの低気圧から見ても同じ浅い側が削れる。効きは相手の配置を
  // 前後 ±窓 で標本化して最強の 1 点を取る — 相手の近い時刻が窓へ出入りするあいだ効きは
  // ~1 日かけて逓増・逓減するので、出会い・別れ・生まれ・消えのどの瞬間にも深さは跳ばない。
  // 最深で比べる門も標本ごとの居る度が 0 の時刻にしか入れ替わらない。
  let depth = self.placement.depth;
  for (let j = index % 2; j < LOW_COUNT; j += 2) {
    if (j === index) continue;
    // 窓の標本の効きは、本物の最大をなめらかに近似した総和でたたむ — 最強の標本が隣の刻みへ
    // 移る瞬間にも効きは連続に移り、勾配が刻みの境で跳ばない。
    let softmax = 0;
    for (let k = -ABSORB_WINDOW_STEPS; k <= ABSORB_WINDOW_STEPS; k++) {
      const other = rawAt(j, k);
      // その標本の低気圧が自分より最深の浅い側なら、その標本は呑まない。
      if (other === null || other.peakDepth < self.peakDepth) continue;
      const distance = greatCircleDistance(self.placement, other.placement, surfaceRadius);
      const edge = self.placement.radius + other.placement.radius;
      const fade = THREE.MathUtils.smoothstep(
        distance, edge * ABSORB_FADE_FULL, edge * ABSORB_FADE_START,
      );
      // 効きは近くて居る時刻が窓に入っているあいだ効き、出会いの前後 ~1 日に逓増・逓減がかかる。
      // 標本ごとの居る度は生まれ・消えで 0 へ逓減するので、相手が生まれた・埋まる瞬間にも効きは
      // 跳ばない — 呑む側の瞬間の深さを見ると、相手が埋まる速さで効きが抜けて抑えられていた側の
      // 深さが跳ぶ。帯の縁での効きは二乗で弱めて、総和で届きすぎないよう実効の帯をおおよそ
      // 1.4 倍までに留める。窓の端では 0 へ逓減。
      const taper = 0.5 + 0.5 * Math.cos(Math.PI * k / ABSORB_WINDOW_STEPS);
      const reach = (1 - fade) ** 2;
      // 居る度と現在の深さの強いほうを効きにする — 生まれたて・消えかけでも、深さがあれば
      // 半径の和の内側へ来た浅い谷をその時点で沈め切れる。
      const strength = Math.max(
        other.presence, Math.min(1, other.placement.depth / ABSORB_FADE_DEPTH),
      );
      softmax += Math.expm1(ABSORB_SOFTMAX * taper * strength * reach);
    }
    if (softmax <= 0) continue;
    // 効きは総和の対数から — expm1/log1p の対で、効き 0 の標本は総和へ寄与しない。1 へ収まる
    // よう丸める — 複数の標本がほぼ最強で並ぶときの持ち上がりぶん。
    const grip = Math.min(1, Math.log1p(softmax) / ABSORB_SOFTMAX);
    depth *= 1 - grip;
  }
  return { ...self.placement, depth };
}

// 2 つの配置の中心の大圏距離 [m]。
function greatCircleDistance(
  a: PressurePlacement, b: PressurePlacement, surfaceRadius: number,
): number {
  const cosAngle = Math.sin(a.latitude) * Math.sin(b.latitude)
    + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.cos(a.longitude - b.longitude);
  return surfaceRadius * Math.acos(Math.min(Math.max(cosAngle, -1), 1));
}
