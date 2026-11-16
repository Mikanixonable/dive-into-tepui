// 開発サーバを立てたとき、同じアドレスのタブが既にブラウザで開いていればそのタブを前面に出して再読み込みし、
// 無ければ新しいタブで開く。macOS の既定ブラウザが Chromium 系(Chrome・Edge・Brave・Arc)のときだけ
// タブを探せる(AppleScript。初回は「ブラウザの制御を許可」の確認が出る)。それ以外の環境は、
// 従来どおり新しいタブで開く。
'use strict';
const { execFile, spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// 既定ブラウザの bundle id → AppleScript で指すアプリ名(Chromium 系。タブの辞書が同じ)。
const CHROMIUM_APPS = {
  'com.google.chrome': 'Google Chrome',
  'com.microsoft.edgemac': 'Microsoft Edge',
  'com.brave.browser': 'Brave Browser',
  'company.thebrowser.browser': 'Arc',
};
const LAUNCH_SERVICES_PLIST = path.join(
  os.homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');

// url で始まるタブを探し、あれば前面へ出して再読み込みする。無ければ新しいタブで開く。
const FIND_OR_OPEN_SCRIPT = `
on run argv
  set theURL to item 1 of argv
  set appName to item 2 of argv
  using terms from application "Google Chrome"
    tell application appName
      set found to false
      repeat with w in windows
        set i to 0
        repeat with t in tabs of w
          set i to i + 1
          if (URL of t) starts with theURL then
            tell t to reload
            set active tab index of w to i
            set index of w to 1
            set found to true
            exit repeat
          end if
        end repeat
        if found then exit repeat
      end repeat
      if not found then
        if (count of windows) is 0 then make new window
        tell front window to make new tab with properties {URL:theURL}
      end if
      activate
    end tell
  end using terms from
end run
`;

// 既定ブラウザが Chromium 系なら、その AppleScript 上のアプリ名。そうでなければ null。
function defaultChromiumApp() {
  return new Promise((resolve) => {
    execFile('plutil', ['-convert', 'json', '-o', '-', LAUNCH_SERVICES_PLIST], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      try {
        const handlers = JSON.parse(stdout).LSHandlers ?? [];
        const entry = handlers.find((handler) => handler.LSHandlerURLScheme === 'http');
        resolve(CHROMIUM_APPS[String(entry?.LSHandlerRoleAll ?? '').toLowerCase()] ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

// OS の既定の開き方で新しいタブとして開く。
function openNewTab(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

// url を開く。既存のタブを再利用できるなら再利用し、できなければ新しいタブで開く。
async function openOrReuseTab(url) {
  const app = process.platform === 'darwin' ? await defaultChromiumApp() : null;
  if (app === null) {
    openNewTab(url);
    return;
  }
  const script = execFile('osascript', ['-', url, app], (error, _stdout, stderr) => {
    if (error) {
      console.warn(`[open-dev-page] タブの再利用に失敗したので新しいタブで開く: ${stderr.trim()}`);
      openNewTab(url);
    }
  });
  script.stdin.end(FIND_OR_OPEN_SCRIPT);
}

// webpack-dev-server の onListening へ渡す関数。v6 では onListening が呼ばれる時点で最初の
// コンパイル完了と listen 開始が済んでいるので、そのままページを開く。
function openDevPageWhenReady(devServer) {
  const { port } = devServer.server.address();
  void openOrReuseTab(`http://localhost:${port}/`);
}

module.exports = { openOrReuseTab, openDevPageWhenReady };
