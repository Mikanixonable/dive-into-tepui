// ステージごとの補給と機体修復の許可をまとめる。
export interface StageRules {
  readonly automaticResupply: boolean;
  readonly selfRepair: boolean;
}

export const CAMPAIGN_STAGE_RULES: StageRules = {
  automaticResupply: false,
  selfRepair: false,
};

export const FREE_PLAY_STAGE_RULES: StageRules = {
  automaticResupply: true,
  selfRepair: true,
};
