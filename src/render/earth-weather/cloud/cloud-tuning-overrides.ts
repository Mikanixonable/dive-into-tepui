// 調整値の上書き。ここは常に空で、ゲームは既定値のまま動く。`npm run dev` のビルドだけが、この
// モジュールを git 管理外の上書きファイル(tools/cloud-tuning-overrides-file.cjs)へ差し替える。
export const CLOUD_TUNING_OVERRIDES: Readonly<Record<string, number>> = {};
