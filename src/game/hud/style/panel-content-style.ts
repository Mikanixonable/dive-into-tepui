// 画面ごとに分けたパネル内容の CSS を、定義順を保って結合する。
import { COMBAT_PANEL_ROWS_STYLE } from './combat-panel-rows-style';
import { PLAN_PANEL_STYLE } from './plan-panel-style';
import { VIEW_OPTIONS_STYLE } from './view-options-style';
import { PREDICT_STYLE } from './predict-style';
import { FRAME_CONTROLS_STYLE } from './frame-controls-style';
import { ORBIT_GUIDE_STYLE } from './orbit-guide-style';
import { STAGE_CONTROLS_STYLE } from './stage-controls-style';
import { OBJECT_PLACER_STYLE } from './object-placer-style';
import { NAVBALL_STYLE } from './navball-style';
import { RESULT_SCREEN_STYLE } from './result-screen-style';
import { HELP_PANEL_STYLE } from './help-panel-style';
import { STAGE_STATUS_STYLE } from './stage-status-style';
import { PAUSE_MENU_STYLE } from './pause-menu-style';
import { SETTINGS_VIEW_STYLE } from './settings-view-style';

export const PANEL_CONTENT_STYLE =
  COMBAT_PANEL_ROWS_STYLE + PLAN_PANEL_STYLE + VIEW_OPTIONS_STYLE + PREDICT_STYLE
  + FRAME_CONTROLS_STYLE + ORBIT_GUIDE_STYLE + STAGE_CONTROLS_STYLE + OBJECT_PLACER_STYLE
  + NAVBALL_STYLE + RESULT_SCREEN_STYLE + HELP_PANEL_STYLE + STAGE_STATUS_STYLE
  + PAUSE_MENU_STYLE + SETTINGS_VIEW_STYLE;
