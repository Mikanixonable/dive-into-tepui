// AI エージェントが「自分のセッションで眠るべきか」「誰へ委譲できるか」を判断するための、利用枠の残量チェック。
//   npm run usage -- --runtime=claude  Claude Code の枠で判定
//   npm run usage -- --runtime=devin-luna Devin Luna の有料モデル枠で判定
//   npm run usage -- --runtime=claude --json  機械可読(同じ内容)
//   npm run usage -- --runtime=claude --brief 1 行(SessionStart フックが会話の文脈へ入れる)
//   npm run usage -- --wait=claude     Claude Code の枠が戻るまで待って終了(run_in_background で起床タイマーにする)
//   npm run usage -- --wait=devin-luna Devin Luna の枠が戻るまで待って終了
//   npm run usage -- --wait=swe2       SWE-2 のレート制限が解けるまで待って終了
//   --threshold=90   Claude の使用率がこの % 以上なら「眠る」(既定 95)
//   --reset-5h=13:55 Claude の解除時刻が取れないときの起床計算用(ユーザーに聞いた時刻)
//
// 停止判定には runtime の指定が必須。Claude と Devin の枠を誤って混同しない。
//   0: 続行してよい / 1: 眠る(新しい作業を始めず、区切りで引き継ぎメモを書いて止まる) / 2: 値が不明
//
// 取得元:
//   Claude: Claude Code の OAuth トークン(macOS keychain)で /api/oauth/usage を呼ぶ。取れなければ
//           statusline が書く ~/.claude/state/five_hour.json(15 分より古ければ不明)。
//   Devin の quota(日次・週次): credentials.toml のトークンで GetUserStatus を呼ぶ。**有料モデル(luna など)専用の枠**で、
//           SWE-2 は消費しない。SWE-2 は無料モデルで、別枠のレート制限がかかる。
//   SWE-2 のレート制限: API が無いので、Devin の転写(~/.local/share/devin/cli/transcripts)に残る
//           「Reached free model rate limit ... (at HH:MM UTC)」から解除時刻を拾う。
//   どれも文書化された API ではない。形が変わったら「不明」になる。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decideUsage } from './usage-verdict.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const asJson = args.includes('--json');
const brief = args.includes('--brief');
const waitFor = flag('wait');
const runtimeArg = flag('runtime');
const RUNTIMES = ['claude', 'devin-luna'];
if (runtimeArg && !RUNTIMES.includes(runtimeArg)) {
  console.error(`--runtime は ${RUNTIMES.join(' または ')} を指定してください`);
  process.exit(2);
}
if (waitFor && !['claude', 'devin-luna', 'swe2'].includes(waitFor)) {
  console.error('--wait は claude / devin-luna / swe2 を指定してください');
  process.exit(2);
}
if (waitFor && waitFor !== 'swe2' && runtimeArg && runtimeArg !== waitFor) {
  console.error('--wait と --runtime は同じ対象を指定してください');
  process.exit(2);
}
if (!runtimeArg && !waitFor) {
  console.error('判定対象を --runtime=claude または --runtime=devin-luna で指定してください');
  process.exit(2);
}
const runtime = waitFor && waitFor !== 'swe2' ? waitFor : runtimeArg ?? 'claude';
const THRESHOLD = Number(flag('threshold') ?? 95);
const resetArg = flag('reset-5h');
const STALE_SEC = 900;
const TRANSCRIPT_WINDOW_SEC = 8 * 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

// ---- Claude ----

async function readClaudeOauth() {
  let token;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    token = JSON.parse(raw).claudeAiOauth?.accessToken;
  } catch {
    return null;
  }
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const window = (w) => (w?.utilization == null ? null : { usedPct: Number(w.utilization), resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null });
    const fiveHour = window(j.five_hour);
    const sevenDay = window(j.seven_day);
    return fiveHour || sevenDay ? { known: true, source: 'oauth', fiveHour, sevenDay } : null;
  } catch {
    return null;
  }
}

function readClaudeStatusline() {
  const file = path.join(homedir(), '.claude/state/five_hour.json');
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { known: false, reason: 'OAuth で取れず、statusline の値(five_hour.json)も無い' };
  }
  const age = nowSec() - state.written_at;
  if (age > STALE_SEC) return { known: false, reason: `OAuth で取れず、statusline の値も ${age} 秒前のもの` };
  const window = (usedPct, resetsAt) => (usedPct == null ? null : { usedPct, resetsAt: resetsAt ?? null });
  return {
    known: true,
    source: 'statusline',
    fiveHour: window(state.used_percentage, state.resets_at),
    sevenDay: window(state.seven_day_used_percentage, state.seven_day_resets_at),
  };
}

async function readClaude() {
  const claude = (await readClaudeOauth()) ?? readClaudeStatusline();
  if (!claude.known) return claude;
  // リセット時刻を過ぎていれば枠は回復している
  for (const key of ['fiveHour', 'sevenDay']) {
    const w = claude[key];
    if (w && w.resetsAt != null && nowSec() >= w.resetsAt) claude[key] = { usedPct: 0, resetsAt: null };
  }
  return claude;
}

// ---- Devin ----

async function readDevinQuota() {
  let key;
  try {
    const toml = readFileSync(path.join(homedir(), '.local/share/devin/credentials.toml'), 'utf8');
    key = /windsurf_api_key\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  } catch {
    return { known: false, reason: 'credentials.toml が読めない(devin auth login が要る)' };
  }
  if (!key) return { known: false, reason: 'credentials.toml に api key が無い' };
  try {
    const res = await fetch('https://server.codeium.com/exa.api_server_pb.ApiServerService/GetUserStatus', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body: JSON.stringify({ metadata: { apiKey: key, ideName: 'devin-cli', extensionName: 'devin-cli', ideVersion: '1.0.0', extensionVersion: '1.0.0' } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { known: false, reason: `GetUserStatus が ${res.status}` };
    const plan = (await res.json())?.userStatus?.planStatus;
    if (!plan) return { known: false, reason: '応答に planStatus が無い(API の形が変わった可能性)' };
    // proto3 の JSON は値が 0 のフィールドを省く。解除時刻があるのに残量が無い枠は、不明でなく 0%(枯渇)。
    const window = (remaining, resetAt) => {
      if (remaining == null && resetAt == null) return null;
      return { remainingPct: Number(remaining ?? 0), resetsAt: resetAt == null ? null : Number(resetAt) };
    };
    return { known: true, daily: window(plan.dailyQuotaRemainingPercent, plan.dailyQuotaResetAtUnix), weekly: window(plan.weeklyQuotaRemainingPercent, plan.weeklyQuotaResetAtUnix) };
  } catch (e) {
    return { known: false, reason: `取得に失敗: ${e.message}` };
  }
}

// 転写の「(at HH:MM UTC)」を、そのファイルの更新時刻の直前以降で最初に来るその時刻へ解決する
function readSwe2Limit() {
  const dir = path.join(homedir(), '.local/share/devin/cli/transcripts');
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, mtime: Math.floor(statSync(path.join(dir, f)).mtimeMs / 1000) }))
      .filter((x) => nowSec() - x.mtime < TRANSCRIPT_WINDOW_SEC)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return { known: false, limitedUntil: null };
  }
  let latest = null;
  for (const { f, mtime } of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const matches = [...text.matchAll(/free model rate limit[^"]*?\(at (\d{2}):(\d{2}) UTC\)/g)];
    if (matches.length === 0) continue;
    const [, hh, mm] = matches[matches.length - 1];
    const d = new Date((mtime - 1800) * 1000);
    d.setUTCHours(Number(hh), Number(mm), 0, 0);
    if (d.getTime() / 1000 < mtime - 1800) d.setUTCDate(d.getUTCDate() + 1);
    const until = Math.floor(d.getTime() / 1000);
    if (!latest || until > latest) latest = until;
  }
  return { known: true, limitedUntil: latest != null && latest > nowSec() ? latest : null };
}

// ---- 集約 ----

function nextClock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  if (!m) return null;
  const d = new Date();
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() / 1000 <= nowSec()) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}

async function snapshot(targetRuntime = runtime) {
  const [claude, devinQuota] = await Promise.all([readClaude(), readDevinQuota()]);
  const swe2 = readSwe2Limit();

  // 委譲先: SWE-2 は無料で別枠。レート制限中でなければ SWE-2、制限中なら Haiku
  const delegate = swe2.limitedUntil ? 'haiku' : 'devin-swe2';
  const quotaWindows = [devinQuota.daily, devinQuota.weekly].filter(Boolean);
  const paidModels = devinQuota.known
    ? { usable: quotaWindows.length > 0 ? quotaWindows.every((w) => w.remainingPct > 0) : null, ...devinQuota }
    : { usable: null, ...devinQuota };
  const decision = decideUsage(targetRuntime, {
    claude,
    devinPaidQuota: paidModels,
    threshold: THRESHOLD,
    claudeResetAt: nextClock(resetArg),
  });
  const { verdict, wakeAt } = decision;
  return {
    runtime: targetRuntime,
    verdict,
    threshold: THRESHOLD,
    now: nowSec(),
    wakeAt,
    wakeInSec: wakeAt == null ? null : wakeAt - nowSec(),
    delegate,
    swe2LimitedUntil: swe2.limitedUntil,
    claude,
    devinPaidQuota: paidModels,
  };
}

const fmtReset = (resetsAt) => {
  if (resetsAt == null) return '解除時刻不明';
  const min = Math.max(0, Math.round((resetsAt - nowSec()) / 60));
  const at = new Date(resetsAt * 1000).toLocaleString('ja-JP', { hour12: false });
  return `${at} 解除(あと ${Math.floor(min / 60)}時間${min % 60}分)`;
};
const clock = (sec) => new Date(sec * 1000).toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit' });

function printBrief(s) {
  const target = s.runtime === 'claude' ? 'Claude Code' : 'Devin Luna';
  const quota = s.runtime === 'claude'
    ? s.claude.known
      ? `Claude 5h ${s.claude.fiveHour?.usedPct ?? '?'}%${s.claude.fiveHour?.resetsAt ? `(${clock(s.claude.fiveHour.resetsAt)}解除)` : ''} 週間 ${s.claude.sevenDay?.usedPct ?? '?'}%${s.claude.sevenDay?.resetsAt ? `(${new Date(s.claude.sevenDay.resetsAt * 1000).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })} ${clock(s.claude.sevenDay.resetsAt)}解除)` : ''}`
      : 'Claude 枠: 不明'
    : s.devinPaidQuota.known
      ? `Devin Luna 日次 ${s.devinPaidQuota.daily?.remainingPct ?? '?'}% 週次 ${s.devinPaidQuota.weekly?.remainingPct ?? '?'}%`
      : 'Devin Luna 枠: 不明';
  const d = s.swe2LimitedUntil ? `SWE-2 は ${clock(s.swe2LimitedUntil)} までレート制限中 → Haiku へ` : 'SWE-2 は使える';
  console.log(`[利用枠] 判定対象 ${target} / ${quota} / ${d} / 判定 ${s.verdict}。詳細: npm run usage -- --runtime=${s.runtime}、運用: /autopilot`);
}

function printTable(s) {
  console.log('[Claude 購読枠]');
  if (!s.claude.known) console.log(`  不明: ${s.claude.reason}`);
  else {
    for (const [label, w] of [['5h  ', s.claude.fiveHour], ['週間', s.claude.sevenDay]]) {
      console.log(w ? `  ${label}: 使用 ${w.usedPct}% / ${fmtReset(w.resetsAt)}` : `  ${label}: 不明`);
    }
  }
  console.log('[Devin]');
  console.log(s.swe2LimitedUntil ? `  SWE-2(無料・別枠): レート制限中 / ${fmtReset(s.swe2LimitedUntil)}` : '  SWE-2(無料・別枠): 制限なし(直近の転写に未解除のレート制限は無い)');
  const q = s.devinPaidQuota;
  if (!q.known) console.log(`  有料モデル枠: 不明: ${q.reason}`);
  else {
    for (const [label, w] of [['日次', q.daily], ['週次', q.weekly]]) {
      console.log(w ? `  有料モデル枠(luna など。SWE-2 は消費しない) ${label}: 残り ${w.remainingPct}% / ${fmtReset(w.resetsAt)}` : `  有料モデル枠 ${label}: 不明`);
    }
  }
  const target = s.runtime === 'claude' ? 'Claude Code' : 'Devin Luna';
  console.log(`判定対象: ${target}`);
  const advice = {
    CONTINUE: s.runtime === 'claude'
      ? `続行してよい(Claude の使用率が ${s.threshold}% 未満)`
      : '続行してよい(Devin Luna の日次・週次有料モデル枠が残っている)',
    SLEEP: s.runtime === 'claude'
      ? `眠る: 新しい作業を始めず、区切りで引き継ぎメモを書いて止まる(Claude の使用率が ${s.threshold}% 以上)`
      : '眠る: Devin Luna の日次または週次有料モデル枠が枯渇している',
    UNKNOWN: s.runtime === 'claude'
      ? '判断できない: Claude の解除時刻を確認し、必要なら --reset-5h=HH:MM を付けて再実行する'
      : '判断できない: Devin Luna の有料モデル枠が取得できない',
  };
  console.log(`判定: ${s.verdict} — ${advice[s.verdict]}`);
  console.log(`委譲先: ${s.delegate === 'devin-swe2' ? 'Devin SWE-2(/delegate-devin)' : 'Haiku 5.5(Agent の model: haiku)'}`);
  if (s.swe2LimitedUntil) console.log('SWE-2 の復活: タイマー → npm run usage -- --wait=swe2 を run_in_background で走らせ、戻ったら SWE-2 へ切り替える');
  if (s.wakeAt != null) {
    const waitFlag = s.runtime === 'claude' ? 'claude' : 'devin-luna';
    console.log(`起床の目安: ${fmtReset(s.wakeAt)} → npm run usage -- --wait=${waitFlag} を run_in_background で走らせてから眠る`);
  }
}

// ---- 実行 ----

if (waitFor) {
  // 解除時刻まで眠り、その後 1 分ごとに実際に戻ったかを確かめる。戻ったら 0 で終わる(終了の通知が起床の合図)。
  for (;;) {
    const s = await snapshot();
    const ready = waitFor === 'swe2' ? s.swe2LimitedUntil == null : s.verdict === 'CONTINUE';
    if (ready) {
      if (waitFor === 'swe2') {
        console.log('SWE-2 が戻った。');
      } else {
        console.log(`${waitFor} が戻った。`);
        printBrief(s);
      }
      process.exit(0);
    }
    const target = waitFor === 'swe2' ? s.swe2LimitedUntil : s.wakeAt;
    const sleepSec = target != null && target > nowSec() ? Math.min(target - nowSec() + 5, 1800) : 60;
    await new Promise((r) => setTimeout(r, sleepSec * 1000));
  }
}

const s = await snapshot();
if (asJson) console.log(JSON.stringify(s, null, 2));
else if (brief) printBrief(s);
else printTable(s);
process.exit(brief ? 0 : { CONTINUE: 0, SLEEP: 1, UNKNOWN: 2 }[s.verdict]);
