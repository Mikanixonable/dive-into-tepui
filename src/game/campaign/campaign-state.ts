// ストーリーモードのキャンペーン1つぶんの進行状態と、その状態遷移。
// 状態は不変な JSON の素の値だけで組み、遷移は新しい状態を返す純粋関数として書く。
// どのスロットに属し、いつ書き戻すかという永続化は launcher が持つ(SAVE.md「キャンペーン状態」)。
import type { RunEventBody } from '../run-events';

// キャンペーンの幕(GAME.md 11.2)。
export type CampaignAct = 1 | 2 | 3 | 4;

// 指揮中枢の状態。破壊された時点でキャンペーンはクリアになる(GAME.md 11.3)。
export type CommandCoreState = 'intact' | 'destroyed';

// 拠点1つぶんの備蓄。素材は建造・修理・弾薬の通貨、推進剤は補給の対象(GAME.md 11.4)。
export interface BaseStockpile {
  readonly materials: number;
  readonly propellant: number;
}

// 備蓄がまだ無い拠点の備蓄。
export const EMPTY_STOCKPILE: BaseStockpile = { materials: 0, propellant: 0 };

// クリア後の評価に使う、キャンペーンを通しての集計(SAVE.md「キャンペーン状態」)。
export interface CampaignStats {
  // 失ったプレイヤーの艦の数。
  readonly shipsLost: number;
  // 撃破した敵の総数。襲撃の敵の撃破も数える。
  readonly totalKills: number;
  // 建造を完了した枝の乾燥質量の合計 [kg]。
  readonly builtMassKg: number;
  // 経過したゲーム内時間の累計 [sim s]。
  readonly elapsedSeconds: number;
}

// 集計がまだ無いキャンペーンの集計。
export const EMPTY_CAMPAIGN_STATS: CampaignStats = {
  shipsLost: 0, totalKills: 0, builtMassKg: 0, elapsedSeconds: 0,
};

// ストーリーのステージが経過時間をキャンペーンへ報告する間隔 [sim s]。この量以上
// たまってから出来事として送り、端数はステージ側に残る。
export const CAMPAIGN_ELAPSED_REPORT_SECONDS = 3600;

// キャンペーンの進行状態。セーブスロットがステージ履歴とは別に1つ持つ。
export interface CampaignState {
  readonly act: CampaignAct;
  readonly commandCore: CommandCoreState;
  // 拠点 id → その拠点の備蓄。備蓄が生まれた拠点だけが項目を持つ。
  readonly stockpiles: Readonly<Record<string, BaseStockpile>>;
  // 撃破済みの敵の識別子。撃破した敵は二度と戻らない(GAME.md 11.2)。
  readonly defeatedEnemyIds: readonly string[];
  // 軌道造船所が完成したかどうか。完成はキャンペーンの進行で、再入場しても失われない
  // (GAME.md 11.2)。
  readonly shipyardBuilt: boolean;
  // クリア後の評価に使う集計。
  readonly stats: CampaignStats;
}

// 始めたばかりのキャンペーン。第1幕から始まり、中枢は健在で、備蓄と撃破記録は空。
export function createCampaignState(): CampaignState {
  return {
    act: 1, commandCore: 'intact', stockpiles: {}, defeatedEnemyIds: [], shipyardBuilt: false,
    stats: EMPTY_CAMPAIGN_STATS,
  };
}

// 記録に無い項目を基底値で補った状態(SAVE.md「形式の版」)。集計を持たない旧い記録を
// 読むために使う。項目が揃っていれば状態はそのまま返る。
export function fillCampaignDefaults(state: CampaignState): CampaignState {
  return state.stats == null ? { ...state, stats: EMPTY_CAMPAIGN_STATS } : state;
}

// クリア済みかどうか。中枢の破壊そのものがクリアである(GAME.md 11.3)。
export function isCampaignCleared(state: CampaignState): boolean {
  return state.commandCore === 'destroyed';
}

// 幕を進めた状態。進行は後退しないため、現在以下の幕では状態がそのまま返る(GAME.md 11.2)。
export function advanceCampaignAct(state: CampaignState, act: CampaignAct): CampaignState {
  return act > state.act ? { ...state, act } : state;
}

// 敵1機の撃破を記録した状態。記録済みの敵では状態がそのまま返る。
export function recordEnemyDefeated(state: CampaignState, enemyId: string): CampaignState {
  if (state.defeatedEnemyIds.includes(enemyId)) return state;
  return { ...state, defeatedEnemyIds: [...state.defeatedEnemyIds, enemyId] };
}

// 指揮中枢の破壊を記録した状態。この記録がキャンペーンの決着である(GAME.md 11.3)。
export function recordCommandCoreDestroyed(state: CampaignState): CampaignState {
  return state.commandCore === 'destroyed' ? state : { ...state, commandCore: 'destroyed' };
}

// 軌道造船所の完成を記録した状態。記録済みなら状態がそのまま返る。
export function recordShipyardBuilt(state: CampaignState): CampaignState {
  return state.shipyardBuilt === true ? state : { ...state, shipyardBuilt: true };
}

// 拠点 baseId の備蓄。項目が無ければ空の備蓄が返る。
export function stockpileOf(state: CampaignState, baseId: string): BaseStockpile {
  return state.stockpiles[baseId] ?? EMPTY_STOCKPILE;
}

// 拠点 baseId へ素材と推進剤を積み増した状態。
export function addStockpile(
  state: CampaignState, baseId: string, materials: number, propellant: number,
): CampaignState {
  const current = stockpileOf(state, baseId);
  return {
    ...state,
    stockpiles: {
      ...state.stockpiles,
      [baseId]: { materials: current.materials + materials, propellant: current.propellant + propellant },
    },
  };
}

// 進行の出来事の列をキャンペーンへ適用した状態。キャンペーンに関わる出来事だけが
// 状態を変え、関わる出来事が1つも無ければ状態はそのまま返る。同じ出来事を二度適用しても
// 幕は後退せず、完了の記録は冪等である(素材の加算だけは出来事のたびに積まれる)。
export function applyCampaignEvents(
  state: CampaignState, events: readonly RunEventBody[],
): CampaignState {
  let next = state;
  for (const event of events) {
    if (event.kind === 'materialsRecovered') {
      next = addStockpile(next, event.baseId, event.materials, 0);
    } else if (event.kind === 'stockpileChanged') {
      next = addStockpile(next, event.baseId, event.materials, event.propellant);
      // ラン側の台帳とのずれで備蓄が負になることはない — 下限は 0 に留める。
      const stockpile = stockpileOf(next, event.baseId);
      if (stockpile.materials < 0 || stockpile.propellant < 0) {
        next = {
          ...next,
          stockpiles: {
            ...next.stockpiles,
            [event.baseId]: {
              materials: Math.max(0, stockpile.materials),
              propellant: Math.max(0, stockpile.propellant),
            },
          },
        };
      }
    } else if (event.kind === 'enemyDefeated') {
      // 撃破の総数は、まだ記録されていない敵の撃破だけを数える。同じ撃破を二度
      // 数えることはない。
      if (!next.defeatedEnemyIds.includes(event.enemyId)) {
        next = {
          ...recordEnemyDefeated(next, event.enemyId),
          stats: { ...next.stats, totalKills: next.stats.totalKills + 1 },
        };
      }
    } else if (event.kind === 'commandCoreDestroyed') {
      next = recordCommandCoreDestroyed(next);
    } else if (event.kind === 'storyShipLost') {
      next = { ...next, stats: { ...next.stats, shipsLost: next.stats.shipsLost + 1 } };
    } else if (event.kind === 'storyConstructionCompleted') {
      next = { ...next, stats: { ...next.stats, builtMassKg: next.stats.builtMassKg + event.massKg } };
    } else if (event.kind === 'storyElapsedTime') {
      next = { ...next, stats: { ...next.stats, elapsedSeconds: next.stats.elapsedSeconds + event.seconds } };
    } else if (event.kind === 'storyShipyardBuilt') {
      next = recordShipyardBuilt(next);
    } else if (event.kind === 'storyActCompleted' && event.act < 4) {
      next = advanceCampaignAct(next, (event.act + 1) as CampaignAct);
    }
  }
  return next;
}

// 拠点 baseId から素材と推進剤を取り出した状態。備蓄が足りなければ null が返る。
export function spendStockpile(
  state: CampaignState, baseId: string, materials: number, propellant: number,
): CampaignState | null {
  const current = stockpileOf(state, baseId);
  if (current.materials < materials || current.propellant < propellant) return null;
  return {
    ...state,
    stockpiles: {
      ...state.stockpiles,
      [baseId]: { materials: current.materials - materials, propellant: current.propellant - propellant },
    },
  };
}
