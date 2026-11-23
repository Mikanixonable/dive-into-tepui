// 帯鎖の帯ごとの診断の道具(render-lab-screen-space-band-diagnosis.mjs)の、撮影済みの run の読み込み・撮影の準備・閲覧ページ。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUNS, SCAN_PIXELS, SCAN_WIDTH } from './screen-space-chain-runs.mjs';
import { SCENES } from './screen-space-chain-setup.mjs';
import { readFloats } from './screen-space-lab.mjs';

// 撮影済みの run の記録(record.json)。
export function runRecordOf(run) {
  const record = JSON.parse(readFileSync(path.join(RUNS, run, 'record.json'), 'utf8'));
  if (record.run !== run) throw new Error(`${run}: record does not belong to the run`);
  return record;
}

// RGBA の values の、マスク mask の内側の RGB の RMS。
export function maskedRms(values, mask) {
  let square = 0, count = 0;
  for (let p = 0; p < mask.length; p++) if (mask[p]) for (let c = 0; c < 3; c++) { square += values[4 * p + c] ** 2; count++; }
  return Math.sqrt(square / count);
}

// run の撮影 sceneName を表示し、走査の段を run の条件に揃えて本番位相 0 で描く。A が run の one-pass-a.f32 と 0.001 を超えて違えば投げる
// (src/ が run を撮ったときと違う)。走査面のマスクと A の最大差を返す。
export async function preparedScene(lab, run, record, sceneName) {
  const scene = SCENES.find((item) => item.name === sceneName);
  if (!scene) throw new Error(`unknown scene in record: ${sceneName}`);
  const lighting = record.conditions.lighting ?? { occlusionOnly: false, graphics: {} };
  await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: lighting.occlusionOnly ? 1 : 2, set: 'tuning', key: scene.name });
  for (const [key, value] of Object.entries(lighting.graphics ?? {})) await lab.setGraphicsOption(key, value);
  const surface = await lab.readFloat('scan-surface-0', 4);
  const mask = Uint8Array.from({ length: SCAN_PIXELS }, (_, p) => surface[p * 4 + 2] > 0 ? 1 : 0);
  if (!mask.some(Boolean)) throw new Error(`${sceneName}: scan surface mask is empty`);
  await lab.setUpsampleAlphaOne(false);
  await lab.setTier(record.conditions.tier);
  await lab.renderProductionCorrectionPhase(0, true);
  const merged = await lab.readFloat('merged-0', 4);
  const saved = readFloats(path.join(RUNS, run, sceneName, 'one-pass-a.f32'));
  let difference = 0;
  for (let p = 0; p < SCAN_PIXELS; p++) difference = Math.max(difference, Math.abs(merged[p * 4 + 3] - saved[p]));
  if (difference > 0.001) throw new Error(`${sceneName}: A differs from one-pass-a.f32 by ${difference}`);
  return { mask, alphaMaximumDifference: difference };
}

// 全 run の band-diagnosis/ を拾って runs/band-diagnosis.html を書き直す。
export function writeBandDiagnosisIndex() {
  const entries = [];
  for (const label of readdirSync(RUNS)) {
    const recordFile = path.join(RUNS, label, 'record.json');
    if (!existsSync(recordFile)) continue;
    const itemRecord = JSON.parse(readFileSync(recordFile, 'utf8'));
    for (const item of Object.values(itemRecord.scenes ?? {})) {
      const diagnosisFile = path.join(RUNS, label, item.scene, 'band-diagnosis', 'diagnosis.json');
      if (!existsSync(diagnosisFile)) continue;
      entries.push({ run: label, scene: item.scene, passes: itemRecord.conditions.passes, bandCount: itemRecord.conditions.tier.bandCount,
        jitter: itemRecord.conditions.sampling === 'production-seed-scan-representative-raster-jitter',
        diagnosis: JSON.parse(readFileSync(diagnosisFile, 'utf8')), reference: `${label}/${item.scene}/mean-${itemRecord.conditions.passes}-diffuse-clay.png`,
        base: `${label}/${item.scene}/band-diagnosis/` });
    }
  }
  const data = JSON.stringify(entries).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>帯鎖診断</title>
<style>body{font:14px system-ui;margin:20px;background:#17191d;color:#eee}button{font:inherit;margin:3px;padding:7px;background:#30343b;color:#eee;border:1px solid #59616d;border-radius:4px}button[aria-pressed=true]{background:#586b86}#runs,#shots,#bands,#kinds,#zooms{display:flex;flex-wrap:wrap;gap:3px;margin:8px 0}#description,#scales{margin:8px 0;color:#c5ccd5}.images{display:flex;align-items:flex-start;gap:16px;overflow:auto;margin:16px 0}.images figure{margin:0}.images img{display:block;image-rendering:pixelated;background:#222;max-width:none}.images figcaption{color:#adb5c0}table{border-collapse:collapse;margin-top:14px}td,th{border:1px solid #555;padding:5px 8px;text-align:right}#routing{overflow:auto}#routing td{min-width:72px}</style>
<h1>帯鎖診断</h1><div id="runs"></div><div id="shots"></div><div id="bands"></div><div id="kinds"></div><div id="zooms"></div><p id="description"></p><p id="scales"></p><section class="images"><figure><img id="map"><figcaption id="caption"></figcaption></figure><figure><img id="reference"><figcaption>収束平均の diffuse clay</figcaption></figure></section><div id="numbers"></div><div id="routing"></div>
<script>const data=${data};const kinds=[['input','input'],['chained','chained'],['structure','structure'],['residual','residual'],['noise','noise'],['peak','peak'],['input-diff','input-diff']];const descriptions={input:'帯 k の収束先 — 1024 パス平均の、帯 k に振り分けられた補正の増分（走査画素）。',chained:'input を鎖（帯 k の均し）に通した出力。帯 k だけを入れて流したもの。',structure:'input − chained。正 = 均しで失った光（芯の抜け）、負 = 均しで運び込んだ光（漏れ）。',residual:'1 パス（seed 5000）の帯 k を鎖に通した出力 − chained。単パスの色ムラ・輝点。',noise:'residual の 32 seed（5000〜5031）についての画素ごとの RMS。',peak:'|residual| の 32 seed についての画素ごとの最大。RMS に対して大きい所が孤立した輝点。','input-diff':'この run の input − 比べる run の input（--compare）。ジッター有りと無しの差なら、ラスタライズのアーティファクト。'};let chosenRun=0,chosenShot=0,band=0,kind='input',zoom=1;const state={runs:document.querySelector('#runs'),shots:document.querySelector('#shots'),bands:document.querySelector('#bands'),kinds:document.querySelector('#kinds'),zooms:document.querySelector('#zooms')};function button(parent,label,on,active=false,disabled=false){const b=document.createElement('button');b.textContent=label;b.setAttribute('aria-pressed',String(active));b.disabled=disabled;b.onclick=on;parent.append(b)}function runs(){return [...new Set(data.map(x=>x.run))]}function shots(){const r=runs()[chosenRun];return data.filter(x=>x.run===r)}function current(){return shots()[chosenShot]}function drawButtons(){for(const box of Object.values(state))box.replaceChildren();runs().forEach((r,i)=>button(state.runs,r+(data.find(x=>x.run===r).jitter?'（ジッター有り）':'（ジッター無し）'),()=>{chosenRun=i;chosenShot=0;draw()},i===chosenRun));shots().forEach((x,i)=>button(state.shots,x.scene,()=>{chosenShot=i;draw()},i===chosenShot));for(let i=0;i<8;i++)button(state.bands,String(i),()=>{band=i;draw()},band===i,i>=current().bandCount);button(state.bands,'和',()=>{band=8;draw()},band===8,!['input','chained','structure','residual','input-diff'].includes(kind));for(const [k,label] of kinds)button(state.kinds,label,()=>{kind=k;if(band===8&&!['input','chained','structure','residual','input-diff'].includes(k))band=0;draw()},kind===k,k==='input-diff'&&!current().diagnosis.compare);for(const z of [1,4])button(state.zooms,'×'+z,()=>{zoom=z;draw()},zoom===z)}function table(d){const rows=d.bands.map(x=>'<tr><th>'+x.band+'</th><td>'+x.structureRms.toExponential(4)+'</td><td>'+x.noiseRms.toExponential(4)+'</td><td>'+x.peakMax.toExponential(4)+'</td><td>'+x.peakToNoise.toExponential(4)+'</td></tr>').join('');document.querySelector('#numbers').innerHTML='<table><thead><tr><th>帯</th><th>structureRms</th><th>noiseRms</th><th>peakMax</th><th>peakToNoise</th></tr></thead><tbody>'+rows+'</tbody></table>';const route=d.routing;if(!route){document.querySelector('#routing').replaceChildren();return}document.querySelector('#routing').innerHTML='<h3>routing RMS（行: 帯 k、列: 枠 j）</h3><table><tbody>'+route.rms.map((row,i)=>'<tr><th>'+i+'</th>'+row.map(v=>'<td>'+(v===null?'—':v.toExponential(3))+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}function draw(){if(!data.length)return;drawButtons();const x=current(),d=x.diagnosis,which=band===8?kind+'-sum':kind+'-'+band;document.querySelector('#description').textContent=descriptions[kind];document.querySelector('#scales').textContent='尺度: signal ±'+d.scales.signal+'（input/chained）; error ±'+d.scales.error+'（structure/residual/noise/peak'+(d.compare?' / input-diff':'')+'）';const map=document.querySelector('#map');map.src=x.base+which+'.x'+zoom+'.png';map.style.width='${SCAN_WIDTH * 4}px';document.querySelector('#caption').textContent=which+' · ×'+zoom;document.querySelector('#reference').src=x.reference;document.querySelector('#reference').style.width='${SCAN_WIDTH * 4}px';table(d)}document.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const i=kinds.findIndex(x=>x[0]===kind);kind=kinds[(i+(e.key==='ArrowLeft'?-1:1)+kinds.length)%kinds.length][0];draw()}else if(e.key==='ArrowUp'||e.key==='ArrowDown'){band=Math.max(0,Math.min(8,band+(e.key==='ArrowUp'?-1:1)));draw()}else if(/^[1-9]$/.test(e.key)){chosenShot=Math.min(Number(e.key)-1,shots().length-1);draw()}});draw();</script></html>`;
  writeFileSync(path.join(RUNS, 'band-diagnosis.html'), html);
}
