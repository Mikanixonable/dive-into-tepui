import type { AnyPart } from './game-entity/parts';
import type { VesselAssembly } from './vessel/assembly';

// 保存形式は実行時の Stage / EnemyAi / 天体レジストリを参照しない。これらはすべて JSON 上では
// 判別 union または文字列なので、ここで同じ形を定義して保存データ境界を純粋に保つ。
type AttractorId = string;
type GamePhase = 'playing' | 'won' | 'lost' | 'timeup';
type EnemyKindSaveData = { kind: 'drifting' } | { kind: 'stage0'; typeIndex: number };
interface WaveAttackSaveData {
  waveState: 'waiting_for_ammo' | 'spawning_enemies' | 'active_combat';
  spawnTimer: number;
  waveCount: number;
}

export interface Vec3SaveData {
  x: number;
  y: number;
  z: number;
}

export interface QuatSaveData {
  x: number;
  y: number;
  z: number;
  w: number;
}

// PlayerSaveData と BaseSaveData が共有する、Three.js を含まない設計データ境界。
// VesselAssembly は tree と部品の値だけを持つため、JSON 化しても実行時オブジェクトへの参照を持たない。
export type AssemblySaveData = VesselAssembly;

// 基地保存データの拡張形式。フィールド自体は旧セーブに無いため任意だが、現行の書き出しでは必ず
// 1 を入れる。将来読めない形式を安全に既定基地へフォールバックするため、GameSaveData.version とは
// 分けて管理する。
export const BASE_SAVE_FORMAT_VERSION = 1;

export interface DockBindingSaveData {
  readonly vesselId: string;
  readonly slotIndex: number;
  /** Stable assembly-derived port id. slotIndex remains for old saves and recovery. */
  readonly dockId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVec3Value(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isPortRefValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'axial') return value.sign === 1 || value.sign === -1;
  return value.kind === 'lateral'
    && typeof value.primitiveId === 'string'
    && isInteger(value.faceIndex)
    && value.faceIndex >= 0;
}

function isPrimitiveShapeValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'circle':
      return isFiniteNumber(value.radius) && value.radius > 0
        && isInteger(value.branchCount) && value.branchCount >= 2 && value.branchCount <= 6;
    case 'ellipse':
      return isFiniteNumber(value.majorRadius) && value.majorRadius > 0
        && isFiniteNumber(value.minorRadius) && value.minorRadius > 0;
    case 'polygon':
      return isFiniteNumber(value.radius) && value.radius > 0
        && isInteger(value.sides) && [3, 4, 5, 6, 8].includes(value.sides);
    case 'notched':
      return isFiniteNumber(value.radius) && value.radius > 0
        && isInteger(value.sides) && (value.sides === 6 || value.sides === 8);
    default:
      return false;
  }
}

function isSectionValue(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.primitives) || value.primitives.length === 0) return false;
  return value.primitives.every((primitive) => {
    if (!isRecord(primitive) || typeof primitive.id !== 'string'
      || !isPrimitiveShapeValue(primitive.shape) || !isFiniteNumber(primitive.phaseAngle)) return false;
    if (primitive.attachment === null) return true;
    if (!isRecord(primitive.attachment)) return false;
    return typeof primitive.attachment.parentId === 'string'
      && isInteger(primitive.attachment.parentFaceIndex)
      && primitive.attachment.parentFaceIndex >= 0
      && isInteger(primitive.attachment.childFaceIndex)
      && primitive.attachment.childFaceIndex >= 0;
  });
}

function isEdgeKindValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'hull') return true;
  if (value.kind === 'truss') return isFiniteNumber(value.sectionSize) && value.sectionSize > 0;
  return value.kind === 'decoupler' && isFiniteNumber(value.separationImpulse);
}

function isMountPointValue(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'port') {
    return typeof value.nodeId === 'string' && isPortRefValue(value.port);
  }
  return (value.kind === 'surface' || value.kind === 'truss')
    && typeof value.edgeId === 'string'
    && isFiniteNumber(value.along)
    && isFiniteNumber(value.around);
}

function isPartValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.name === 'string'
    && isFiniteNumber(value.weight)
    && isFiniteNumber(value.maxHp)
    && isFiniteNumber(value.hp);
}

// JSON から読んだ assembly の「形」を確認する。部品種別ごとの性能値や、ノード参照の意味的な検証は
// Vessel 側で行うが、ここで配列・数値・判別子を絞ることで壊れた JSON が Three.js/幾何計算へ届かない。
export function isAssemblySaveData(value: unknown): value is AssemblySaveData {
  if (!isRecord(value) || !isRecord(value.tree)
    || !Array.isArray(value.tree.nodes) || !Array.isArray(value.tree.edges)
    || !Array.isArray(value.placements)) return false;

  const nodesOk = value.tree.nodes.every((node) => isRecord(node)
    && typeof node.id === 'string'
    && isVec3Value(node.pos)
    && isVec3Value(node.axis)
    && isFiniteNumber(node.phaseAngle)
    && isSectionValue(node.section));
  if (!nodesOk) return false;

  const edgesOk = value.tree.edges.every((edge) => isRecord(edge)
    && typeof edge.id === 'string'
    && typeof edge.a === 'string'
    && typeof edge.b === 'string'
    && isPortRefValue(edge.portA)
    && isPortRefValue(edge.portB)
    && isFiniteNumber(edge.length)
    && edge.length > 0
    && isEdgeKindValue(edge.kind));
  if (!edgesOk) return false;

  return value.placements.every((placement) => {
    if (!isRecord(placement) || !isPartValue(placement.part)) return false;
    if (placement.kind === 'external') return isMountPointValue(placement.mount);
    return placement.kind === 'internal'
      && Array.isArray(placement.edgeIds)
      && placement.edgeIds.length > 0
      && placement.edgeIds.every((id) => typeof id === 'string');
  });
}

export function isSupportedBaseSaveFormat(formatVersion: number | undefined): boolean {
  return formatVersion === undefined
    || (Number.isInteger(formatVersion)
      && formatVersion >= 1
      && formatVersion <= BASE_SAVE_FORMAT_VERSION);
}

// 保存された slotIndex を優先しつつ、旧セーブ・重複・範囲外の割当は保存順の空きスロットへ移す。
// 空きが無い場合も収容中の船を捨てず、既存復元経路と同じく 0 を返す。
export function resolveDockSlotIndices(
  bindings: readonly DockBindingSaveData[] | undefined,
  vessels: readonly { readonly id: string }[],
  capacity: number,
  portIndexById?: ReadonlyMap<string, number>,
): readonly number[] {
  const slotCount = Number.isInteger(capacity) && capacity > 0 ? capacity : 0;
  const byVesselId = new Map<string, number>();
  const candidates: readonly unknown[] = Array.isArray(bindings) ? bindings : [];
  for (const value of candidates) {
    if (!isRecord(value) || typeof value.vesselId !== 'string') continue;
    const dockId = typeof value.dockId === 'string' ? value.dockId : undefined;
    const stableSlot = dockId === undefined ? undefined : portIndexById?.get(dockId);
    const slotIndex = value.slotIndex;
    const resolved = stableSlot ?? slotIndex;
    if (typeof resolved !== 'number' || !Number.isInteger(resolved)) continue;
    if (resolved < 0 || resolved >= slotCount) continue;
    byVesselId.set(value.vesselId, resolved);
  }

  const occupied = new Set<number>();
  return vessels.map((vessel) => {
    const requested = byVesselId.get(vessel.id);
    if (requested !== undefined && !occupied.has(requested)) {
      occupied.add(requested);
      return requested;
    }
    for (let slot = 0; slot < slotCount; slot++) {
      if (occupied.has(slot)) continue;
      occupied.add(slot);
      return slot;
    }
    return 0;
  });
}

export interface EntitySaveData {
  id: string;
  name?: string;
  kind: 'player' | 'enemy' | 'ammo';
  r: Vec3SaveData;
  v: Vec3SaveData;
  q: QuatSaveData;
  w: Vec3SaveData;
}

export interface KinematicStateSaveData {
  t: number;
  r: Vec3SaveData;
  v: Vec3SaveData;
}

export interface PlanSaveData {
  anchor: KinematicStateSaveData;
  nodes: KinematicStateSaveData[];
}

export interface FireSaveData {
  mags: number;
  rounds: number;
  barrel: number;
  cooldown: number;
  muzzleIdx: number;
}

export interface ThermalSaveData {
  hullTemp: number;
  pendingHeat: number;
}

export interface RadiatorPanelSaveData {
  deployTarget: 0 | 1;
  deploy: number;
}

export interface RadiatorSaveData {
  up: RadiatorPanelSaveData;
  down: RadiatorPanelSaveData;
}

export interface PowerSaveData {
  charge: number;
}

export interface ThrottleSaveData {
  throttleIdx: number;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定値(true)。
  rcsDamp?: boolean;
  progradeHold?: boolean;
}

export interface PlayerSaveData extends EntitySaveData {
  fire: FireSaveData;
  thermal: ThermalSaveData;
  radiator: RadiatorSaveData;
  power: PowerSaveData;
  throttle: ThrottleSaveData;
  parts: AnyPart[];
  // 第10版のドック編集で確定した形状・取付位置。旧セーブには無く、既定有人艦へ互換復元する。
  assembly?: AssemblySaveData;
  plan: PlanSaveData | null;
  // 旧セーブデータには無いフィールドなので任意。無ければ followPlan から移行する。
  planExecution?: 'off' | 'instant' | 'powered';
  // 'planExecution' 導入前のセーブが持っていたフィールド。
  followPlan?: boolean;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定値(false)。
  fineAttitude?: boolean;
}

// 基地は艦(EntitySaveData)と持ち物が根本的に異なる(在庫・収容艦)ため、
// kind で分岐する EntitySaveData の派生ではなく独立した型にする。
export interface BaseSaveData {
  id: string;
  // 旧セーブデータには無いフィールドなので任意。無ければ既定名。
  name?: string;
  r: Vec3SaveData;
  v: Vec3SaveData;
  // 姿勢と角速度。旧セーブには無いため任意。
  q?: QuatSaveData;
  w?: Vec3SaveData;
  // 基地の燃料。旧セーブには無いため任意。
  fuel?: number;
  // 基地本体の形状・取付位置。旧セーブには無いため、無ければ既定基地へフォールバックする。
  assembly?: AssemblySaveData;
  // 基地保存データの拡張形式。旧セーブには無いため任意。未指定は現行形式として読める。
  formatVersion?: number;
  // 倉庫在庫部品。旧セーブには無いため任意。
  inventory?: AnyPart[];
  // 格納中の艦は entities.ownShips() に含まれないため、艦本体(軌道状態・parts・弾薬・計画)を
  // まるごとここへ保存する。復元時に Vessel を作り直し、DockedVesselEntry.player を張り直す。
  dockedVessels: PlayerSaveData[];
  dockedShips?: PlayerSaveData[];
  // 格納船 id とドックスロットの対応。旧セーブには無いため、無ければ保存順で割り当てる。
  dockBindings?: readonly DockBindingSaveData[];
  throttle?: ThrottleSaveData;
}

export interface EnemySaveData extends EntitySaveData {
  enemyKind: EnemyKindSaveData;
  alive: boolean;
  health: number;
  accent: string | number;
  waveId?: number;
  // バースト射撃の残弾・次弾までの残り時間。未着手なら両方 undefined。
  burstLeft?: number;
  burstDelay?: number;
}

export interface AmmoPickupSaveData extends EntitySaveData {
}

export interface ScoreCounterSaveData {
  shots: number;
  hits: number;
  kills: number;
  losses: number;
  totalEnemiesSpawned: number;
}

export interface LogisticsSaveData {
  resupplyCheckAt: number;
  resupplyEnabled: boolean;
}

// 全ステージ共通の内訳(スコア・決着状態・補給タイマー)。ステージ固有の内訳を持つ
// 具象ステージはこれを拡張した型を自分の serialize() とコンストラクタで使う(stage0.ts の
// Stage0SaveData・stage00.ts の Stage00SaveData)。
export interface StageSaveData {
  scoreCounter: ScoreCounterSaveData;
  phase: GamePhase;
  logistics: LogisticsSaveData;
}

export interface Stage0SaveData extends StageSaveData {
  timeLeft: number;
}

export interface Stage00SaveData extends StageSaveData, WaveAttackSaveData {
}

// クリエイティブモードの内訳。艦0..n隻を自由に配置するモード自身の状態(トグル)に加えて、
// 任意で動かす WaveAttack の進行状態を持つ — waveAttack は waveAttackEnabled が false の
// 間も直前の状態を保つ(OFF→ON で再開したとき波数が0に戻らないように)。
export interface CreativeStageSaveData extends StageSaveData {
  waveAttackEnabled: boolean;
  waveAttack: WaveAttackSaveData;
}

// スナップショットの由来。撮られ方であって、保持されるかどうか(SnapshotMeta.pinned)とは
// 別の軸。クリップは pinned を立てるだけで kind は書き換えない — 由来を塗り替えると
// どのトリガで撮られたかが失われる。
export type SnapshotKind = 'auto' | 'manual' | 'checkpoint';

// 一覧 UI がスナップショット本体を読まずに1件を描くための情報。すべて GameSaveData から
// 導出でき、正本ではなく索引。
export interface SnapshotMeta {
  id: string;
  kind: SnapshotKind;
  pinned: boolean;
  name: string;
  createdAtReal: number;
  simTime: number;
  centerBodyId: AttractorId;
  altitude: number;
  speed: number;
  hpRatio: number;
  maxHp: number;
  magazines: number;
  playerCount: number;
  enemyAliveCount: number;
  phase: GamePhase;
}

// 天体暦を使うスナップショットが、どの絶対時刻・プロファイル・packで生成されたか。
// このフィールドは後方互換のため GameSaveData では任意とする。旧形式には無く、
// 旧スナップショットは SnapshotService が従来どおり復元を試みる。
export interface EphemerisContext {
  epochJdTdb: number;
  profileId: string;
  packId: string;
  packFormatVersion: number;
}

// 1ステージぶんのスナップショット集合とクリア記録。スロットは遊んだステージごとに1件持つ。
export interface StageHistoryMeta {
  stageId: string;
  clearCount: number;
  lastPlayedAtReal: number;
  // 新しい順。
  snapshots: SnapshotMeta[];
}

// セーブデータ(歴史線)1件。
export interface SaveSlotMeta {
  id: string;
  name: string;
  createdAtReal: number;
  lastPlayedAtReal: number;
  lastStageId: string;
  stages: StageHistoryMeta[];
}

// 全スロットのメタを束ねた索引。スナップショット本体は別キーに置き、一覧描画で
// 本体を読まずに済むようにする。
export interface SaveIndex {
  version: number;
  slots: SaveSlotMeta[];
  activeSlotId: string | null;
}

// GameSaveData の形式バージョン。値が変わった時点で、それ以前に書かれたスナップショットは
// 読めなくなる。
export const SAVE_VERSION = 2;

// 書き出しファイルの識別子と形式バージョン。組み立てる側(SaveSlots)と検証する側
// (save-transfer)の両方が参照するので、どちらでもない型定義の場所に置く。
export const SLOT_EXPORT_FORMAT = 'tepui.slot';
export const SLOT_EXPORT_VERSION = 1;

// スロット1件を書き出したファイルの中身。format は無関係な JSON を読ませたときに
// 「壊れたセーブ」ではなく「セーブファイルではない」と判定するための識別子。
export interface SlotExport {
  format: typeof SLOT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAtReal: number;
  slot: SaveSlotMeta;
  // スナップショット id → 本体。
  snapshots: Record<string, GameSaveData>;
}

export interface ChaseCameraSaveData {
  rot: QuatSaveData;
  dist: number;
  pan: Vec3SaveData;
  followAttitude: boolean;
}

// MapCamera のフォーカス対象(FocusTarget の保存形)。'point' は焼き込み先の座標系
// (center/rotatingWith)と、その座標系相対の点をそのまま持つ。
export type FocusTargetSaveData =
  | { kind: 'object'; id: string }
  | { kind: 'point'; center: string; rotatingWith: string | null; point: Vec3SaveData };

export interface MapCameraSaveData {
  offset: Vec3SaveData;
  pan: Vec3SaveData;
  up: Vec3SaveData;
  rotatingWith: string | null;
  focus: FocusTargetSaveData;
  // 旧セーブデータには無い。無ければ既定のオイラー操作。
  rotationMode?: 'quaternion' | 'euler';
  // 旧セーブデータには無い。無ければ既定の広範囲視点 FOV。
  fovDeg?: number;
  // 旧セーブデータには無い。無ければ赤道面。
  referencePlane?: 'ecliptic' | 'equator' | 'moonOrbit';
  projectionMode?: 'perspective' | 'orthographic';
  orthographicHalfHeight?: number;
}

export interface CameraSaveData {
  view: 'combat' | 'map';
  chase: ChaseCameraSaveData;
  overview: MapCameraSaveData;
}

export interface GameSaveData {
  version: number;
  stageId: string;
  simTime: number;
  /** 旧スナップショットには無い。存在する場合は現在の暦と一致しなければ復元しない。 */
  ephemerisContext?: EphemerisContext;
  phaseOffsets: Partial<Record<AttractorId, number>>;
  /** 旧スナップショットには無い。存在しなければ地球の自転初期位相は復元されない。 */
  earthSpinPhase0?: number;
  players: PlayerSaveData[];
  activePlayerId: string | null;
  enemies: EnemySaveData[];
  ammoPickups: AmmoPickupSaveData[];
  bases: BaseSaveData[];
  stage: StageSaveData;
  // 旧セーブデータには無いフィールドなので任意。無ければ視点は既定のまま始まる。
  camera?: CameraSaveData;
}
