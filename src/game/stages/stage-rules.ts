// ステージごとの補給と機体修復の許可、撃破数の鹵獲設計図を数えるかをまとめる。
export interface StageRules {
  readonly automaticResupply: boolean;
  readonly selfRepair: boolean;
  // 撃破数の節目で鹵獲の設計図を授与するか(SPEC GAME.md 3.1)。勝敗判定を行うステージだけが数える。
  readonly salvageRewards: boolean;
}

export const CAMPAIGN_STAGE_RULES: StageRules = {
  automaticResupply: false,
  selfRepair: false,
  salvageRewards: true,
};

export const FREE_PLAY_STAGE_RULES: StageRules = {
  automaticResupply: true,
  selfRepair: true,
  salvageRewards: false,
};
