// ステージごとの補給と機体修復の許可、撃破数の鹵獲を数えるか、鹵獲を補給艇で届けるかをまとめる。
export interface StageRules {
  readonly automaticResupply: boolean;
  readonly selfRepair: boolean;
  // 撃破数の節目で鹵獲を授与するか(SPEC GAME.md 3.1)。勝敗判定を行うステージだけが数える。
  readonly salvageRewards: boolean;
  // 授与された鹵獲を補給艇で波間に届けるか(SPEC GAME.md 2.3)。
  readonly salvageTender: boolean;
}

export const CAMPAIGN_STAGE_RULES: StageRules = {
  automaticResupply: false,
  selfRepair: false,
  salvageRewards: true,
  salvageTender: false,
};

// 無限耐久のステージ。鹵獲を補給艇で届け、最後の節目より後も繰り返し授与する。
export const SURVIVAL_STAGE_RULES: StageRules = {
  ...CAMPAIGN_STAGE_RULES,
  salvageTender: true,
};

export const FREE_PLAY_STAGE_RULES: StageRules = {
  automaticResupply: true,
  selfRepair: true,
  salvageRewards: false,
  salvageTender: false,
};
