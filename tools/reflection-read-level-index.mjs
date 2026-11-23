import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(path.resolve(import.meta.dirname, '..'), '.render-lab-shots', 'ssr-read-levels');
const runsDir = path.join(root, 'runs');
const runs = existsSync(runsDir) ? readdirSync(runsDir).filter((name) => existsSync(path.join(runsDir, name))) : [];
const scenes = Object.fromEntries(runs.map((run) => [run, readdirSync(path.join(runsDir, run))
  .filter((scene) => existsSync(path.join(runsDir, run, scene, 'analysis', 'report.json')))])
  .filter(([, analysed]) => analysed.length > 0));
const entries = Object.fromEntries(Object.keys(scenes).flatMap((run) => scenes[run].map((scene) => {
  const dir = path.join(runsDir, run, scene);
  const report = JSON.parse(readFileSync(path.join(dir, 'analysis', 'report.json'), 'utf8'));
  const scatterFile = path.join(dir, 'analysis', 'scatter.json');
  const scatter = existsSync(scatterFile) ? JSON.parse(readFileSync(scatterFile, 'utf8')) : { series: [] };
  const productionPoint = scatter.series.find((series) => series.key === 'production')?.points[0];
  if (productionPoint) Object.assign(productionPoint.images, { diff: 'production-minus-b', level: 'level-production' });
  const candidatesFile = path.join(dir, 'analysis', 'candidates.json');
  if (existsSync(candidatesFile)) scatter.series.push(...JSON.parse(readFileSync(candidatesFile, 'utf8')).series);
  const sweepFile = path.join(dir, 'analysis', 'sweep.json');
  if (existsSync(sweepFile)) scatter.series.push(...JSON.parse(readFileSync(sweepFile, 'utf8')).series);
  const floorFile = path.join(dir, 'analysis', 'floor.json');
  if (existsSync(floorFile)) scatter.series.push(...JSON.parse(readFileSync(floorFile, 'utf8')).series);
  const noiseFile = path.join(dir, 'analysis', 'noise-bands.json');
  const noise = existsSync(noiseFile) ? JSON.parse(readFileSync(noiseFile, 'utf8')) : null;
  return [`${run}/${scene}`, { report, scatter, noise }];
})));
const html = `<!doctype html>
<meta charset="utf-8">
<title>映り込みの読む段</title>
<style>
body{font:14px system-ui;margin:20px;background:#17191d;color:#d6d8dc}
nav{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
button{padding:7px 11px;color:#eee;background:#343840;border:0;cursor:pointer}
button.selected{background:#167d9a}
img{width:960px;height:540px;object-fit:contain;background:#08090a}
small{display:block;color:#9aa0a8;margin:8px 0}
table{border-collapse:collapse;margin:8px 0 18px;min-width:700px}
td,th{padding:5px 12px;border-bottom:1px solid #2c3036;text-align:right}
td:first-child,th:first-child{text-align:left}
svg{display:block;width:min(1100px,100%);height:560px;background:#17191d}
#hint{color:#9aa0a8}
</style>
<h1>映り込みの読む段</h1>
<nav id="runs"></nav>
<nav id="scenes"></nav>
<p id="hint">左上はぼかし足りない（雑音が多い）。右下はぼかしすぎ（構造誤差が大きい）。固定段の曲線より下へ来る点は、段を画素ごとに選ぶことで得をしている。</p>
<nav id="groups"></nav>
<nav id="axes"></nav>
<svg id="plot" viewBox="0 0 1100 560" role="img"></svg>
<table id="metrics"></table>
<nav id="compare"></nav>
<nav id="view"></nav>
<nav id="kinds"></nav>
<nav id="levels"></nav>
<nav id="nus"></nav>
<nav id="targets"></nav>
<small id="caption"></small>
<img id="image" width="960" height="540">
<table id="noiseTable"></table>
<p id="fine-note">Nf は基準の読む段が 2 未満で輪郭を除いた画素の N。全面の N は輪郭と鏡の少数の画素に支配されるので使わない。</p>
<script>
const scenes=${JSON.stringify(scenes)};
const entries=${JSON.stringify(entries)};
let run=Object.keys(scenes).at(-1);
let scene='';
let group='no-rim';
let axis='N8';
let selected=null;
let imageMode='mean';
let kind='b';
let level=1;
let nu='';
let target='production';
const comparisons=[
  {series:'fixed',point:'0',label:'B'},
  {series:'production',point:'production',label:'本番'},
  {series:'cand-w05',point:'real',label:'幅0.5'},
  {series:'cand-c1',point:'real',label:'曲面c1'},
  {series:'cand-c1k05',point:'real',label:'曲面c1幅0.5'},
  {series:'cand-nvc',point:'real',label:'曲面c1 N·V修正'},
  {series:'cand-nv1',point:'real',label:'N·Vなし'},
  {series:'floor',point:'0.25',label:'下限f=0.25'},
];
const colors={fixed:'#4f9fd6',width:'#d18f28',oracle:'#b274cc',production:'#3fae86',real:'#d18f28'};
function buttons(id,items,value,choose){
  const host=document.getElementById(id);
  host.replaceChildren(...items.map(item=>{
    const button=document.createElement('button');
    button.textContent=item.label??item;
    button.className=(item.value??item)===value?'selected':'';
    button.onclick=()=>choose(item.value??item);
    host.append(button);
    return button;
  }));
}
function active(){return entries[run+'/'+scene]??{report:{},scatter:{series:[]}};}
function axisValue(point,selectedGroup){
  return axis==='Nf'?point.metrics['no-rim-fine']?.N:point.metrics[selectedGroup]?.[axis];
}
function seriesColor(series){
  const fixed={fixed:'#4f9fd6',width:'#d18f28',oracle:'#b274cc',production:'#3fae86',real:'#d18f28',floor:'#e6e6e6'};
  if(fixed[series.key])return fixed[series.key];
  const candidates=active().scatter.series.filter(item=>item.key.startsWith('cand-'));
  const candidateColors=['#e0607e','#58b368','#c9b458'];
  const sweepColors=['#7fb7be','#d39bc1','#9bb26a'];
  const candidateIndex=candidates.findIndex(item=>item.key===series.key);
  if(candidateIndex>=0)return candidateColors[candidateIndex%candidateColors.length];
  const sweeps=active().scatter.series.filter(item=>item.key.startsWith('sweep-c'));
  return sweepColors[Math.max(0,sweeps.findIndex(item=>item.key===series.key))%sweepColors.length];
}
function pointRows(){
  return active().scatter.series.flatMap(series=>series.points.map(point=>({series,point})));
}
function draw(){
  const available=scenes[run]??[];
  if(!available.includes(scene))scene=available[0]??'';
  buttons('runs',Object.keys(scenes),run,value=>{run=value;scene='';draw();});
  buttons('scenes',available,scene,value=>{scene=value;draw();});
  const names=['no-rim','all',...Array.from({length:4},(_,i)=>'rough-'+i),...Array.from({length:4},(_,i)=>'curve-'+i)];
  const labels={'no-rim':'輪郭を除く',all:'全面','rough-0':'粗さ < 0.1','rough-1':'粗さ 0.1–0.2',
    'rough-2':'粗さ 0.2–0.3','rough-3':'粗さ ≥ 0.3','curve-0':'曲がり < 0.002',
    'curve-1':'曲がり 0.002–0.01','curve-2':'曲がり 0.01–0.05',
    'curve-3':'曲がり ≥ 0.05'};
  buttons('groups',names.map(value=>({value,label:labels[value]})),group,value=>{group=value;draw();});
  buttons('axes',[{value:'N',label:'N 1 パス雑音'},{value:'N8',label:'N8 8 px の色ムラ'},
    {value:'Nf',label:'Nf 細かい段の N'}],axis,value=>{axis=value;draw();});
  const shownComparisons=comparisons.filter(item=>pointRows().some(row=>row.series.key===item.series&&row.point.key===item.point));
  buttons('compare',shownComparisons.map(item=>({value:item.series+'/'+item.point,label:item.label})),selected,value=>{selected=value;draw();});
  const selectedPoint=pointRows().find(item=>selected===item.series.key+'/'+item.point.key)?.point;
  const imageOptions=[['mean','平均'],['sample','1 パス'],['diff','差'],['level','段']];
  const availableImages=selectedPoint?imageOptions.filter(([key])=>selectedPoint.images[key]):imageOptions.slice(0,2);
  const shownMode=availableImages.some(([key])=>key===imageMode)?imageMode:'mean';
  buttons('view',availableImages.map(([value,label])=>({value,label})),shownMode,value=>{imageMode=value;draw();});
  drawPlot();
  drawLegacy();
}
function drawPlot(){
  const svg=document.getElementById('plot');
  const rows=pointRows();
  const values=rows.map(({point})=>point.metrics[group]).filter(Boolean);
  const xs=rows.map(({point})=>axisValue(point,group)).filter(value=>value>0);
  const ys=values.map(metric=>metric.S).filter(value=>value>0);
  const minX=Math.log10(Math.min(...xs))-0.1;
  const maxX=Math.log10(Math.max(...xs))+0.1;
  const minY=Math.log10(Math.min(...ys))-0.1;
  const maxY=Math.log10(Math.max(...ys))+0.1;
  const x=value=>80+(Math.log10(value)-minX)/(maxX-minX)*970;
  const y=value=>500-(Math.log10(value)-minY)/(maxY-minY)*410;
  svg.replaceChildren();
  svg.append(svgElement('text',{x:80,y:25,fill:'#9aa0a8'},'系列'));
  let legendX=130;
  for(const series of active().scatter.series){
    svg.append(svgElement('rect',{x:legendX,y:14,width:12,height:12,fill:seriesColor(series)}));
    svg.append(svgElement('text',{x:legendX+18,y:25,fill:'#d6d8dc'},series.label));
    legendX+=40+series.label.length*14;
  }
  addGrid(svg,minX,maxX,minY,maxY,x,y);
  const drawn=new Map();
  for(const {series,point} of rows){
    const metric=point.metrics[group];
    const xValue=axisValue(point,group);
    if(!metric||xValue<=0||metric.S<=0)continue;
    if(!drawn.has(series.key))drawn.set(series.key,[]);
    drawn.get(series.key).push({series,point,metric,px:x(xValue),py:y(metric.S)});
  }
  for(const [key,items] of drawn){
    const series=items[0].series;
    if(series.line){
      const points=items.filter(item=>!item.point.measured).map(item=>item.px+','+item.py).join(' ');
      if(points)svg.append(svgElement('polyline',{points,fill:'none',stroke:seriesColor(series),'stroke-width':2}));
    }
    for(const item of items)drawPoint(svg,item);
  }
  drawTable();
}
function addGrid(svg,minX,maxX,minY,maxY,x,y){
  for(const [low,high,scale] of [[minX,maxX,x],[minY,maxY,y]]){
    const start=Math.floor(low);
    const end=Math.ceil(high);
    for(let power=start;power<=end;power++){
      for(const factor of [1,2,5]){
        const value=factor*10**power;
        if(Math.log10(value)<low||Math.log10(value)>high)continue;
        const position=scale(value);
        const horizontal=scale===y;
        const attributes=horizontal
          ?{x1:80,y1:position,x2:1050,y2:position,stroke:'#2c3036'}
          :{x1:position,y1:70,x2:position,y2:500,stroke:'#2c3036'};
        svg.append(svgElement('line',attributes));
        const labelAttributes=horizontal?{x:8,y:position+4,fill:'#9aa0a8'}
          :{x:position-14,y:525,fill:'#9aa0a8'};
        svg.append(svgElement('text',labelAttributes,factor+'e'+power));
      }
    }
  }
}
function drawPoint(svg,item){
  const {series,point,metric,px,py}=item;
  const activePoint=selected===series.key+'/'+point.key;
  const outline=activePoint?'#fff':'#17191d';
  const marker=point.marker??series.marker;
  const shape={ circle:'circle', square:'square', 'open-square':'square', diamond:'diamond', triangle:'triangle',
    'open-triangle':'triangle' }[marker]??'circle';
  const size=series.key==='production'?11:8;
  let mark;
  if(shape==='circle')mark=svgElement('circle',{cx:px,cy:py,r:size,fill:seriesColor(series),stroke:outline,'stroke-width':2});
  if(shape==='square'){
    const open=marker==='open-square';
    mark=svgElement('rect',{x:px-size,y:py-size,width:size*2,height:size*2,
      fill:open?'none':seriesColor(series),stroke:open?seriesColor(series):outline,'stroke-width':2});
  }
  if(shape==='diamond'){
    const pathData='M'+px+' '+(py-size-2)+' L'+(px+size+2)+' '+py
      +' L'+px+' '+(py+size+2)+' L'+(px-size-2)+' '+py+' Z';
    mark=svgElement('path',{d:pathData,fill:colors.oracle,stroke:outline,'stroke-width':2});
  }
  if(shape==='triangle'){
    const pathData='M'+px+' '+(py-size-2)+' L'+(px+size+2)+' '+(py+size)+' L'+(px-size-2)+' '+(py+size)+' Z';
    const open=marker==='open-triangle';
    mark=svgElement('path',{d:pathData,fill:open?'#17191d':seriesColor(series),stroke:open?seriesColor(series):outline,'stroke-width':2});
  }
  svg.append(mark);
  const hit=svgElement('circle',{cx:px,cy:py,r:12,fill:'transparent',cursor:'pointer'});
  hit.append(svgElement('title',{},series.label+' / '+point.label+'\\nS '+metric.S+'\\nN '+metric.N+'\\nN8 '+metric.N8));
  hit.onclick=()=>{
    if(!point.images.mean&&!point.images.sample&&!point.images.diff&&!point.images.level)return;
    selected=series.key+'/'+point.key;
    draw();
  };
  svg.append(hit);
  if(series.key==='fixed'||(series.key==='width'&&point.key==='1')){
    svg.append(svgElement('text',{x:px+8,y:py-9,fill:'#d6d8dc'},point.label));
  }
}
function drawTable(){
  const table=document.getElementById('metrics');
  table.replaceChildren();
  const header=document.createElement('tr');
  for(const label of ['系列','点','S','N','N8','Nf']){const cell=document.createElement('th');cell.textContent=label;header.append(cell);}
  table.append(header);
  for(const {series,point} of pointRows()){
    const metric=point.metrics[group];
    if(!metric)continue;
    const row=document.createElement('tr');
    const nf=point.metrics['no-rim-fine']?.N;
    for(const value of [series.label,point.label,metric.S.toExponential(3),metric.N.toExponential(3),
      metric.N8.toExponential(3),Number.isFinite(nf)?nf.toExponential(3):'—']){
      const cell=document.createElement('td');cell.textContent=value;row.append(cell);
    }
    table.append(row);
  }
}
function drawImage(point=null){
  const selectedPoint=point??pointRows().find(item=>selected===item.series.key+'/'+item.point.key)?.point;
  if(selectedPoint){
    const image=selectedPoint.images[imageMode]||selectedPoint.images.mean||selectedPoint.images.sample;
    if(image){
      document.getElementById('image').src='runs/'+encodeURIComponent(run)+'/'
        +encodeURIComponent(scene)+'/analysis/'+image+'.png';
    }
    return;
  }
  if(kind.startsWith('noise-')){
    document.getElementById('image').src='runs/'+encodeURIComponent(run)+'/'+encodeURIComponent(scene)
      +'/analysis/'+kind+'-'+target+'.png';
    return;
  }
  const file=kind==='L'?'L'+level:kind==='L-minus-b'?'L'+level+'-minus-b':kind==='sample-L'?'sample-L'+level:
    ['level-bal','over','oracle','oracle-minus-b','sample-oracle'].includes(kind)?kind+'-nu'+nu:kind;
  document.getElementById('image').src='runs/'+encodeURIComponent(run)+'/'+encodeURIComponent(scene)+'/analysis/'+file+'.png';
}
function drawLegacy(){
  const report=active().report;
  const categories=['b','production','sample-production','sample-L0','level-production',
    'production-minus-b','L','L-minus-b','sample-L','level-bal','over','oracle',
    'oracle-minus-b','sample-oracle','noise-all','noise-fine','noise-coarse','noise-leak'];
  const labels={b:'B',production:'本番','sample-production':'本番 1 パス',
    'sample-L0':'段 0 の 1 パス','level-production':'本番の段',
    'production-minus-b':'本番 − B',L:'固定段像','L-minus-b':'固定段像 − B',
    'sample-L':'固定段 1 パス','level-bal':'釣り合い段',
    over:'本番段 − 釣り合い段',oracle:'オラクル',
    'oracle-minus-b':'オラクル − B','sample-oracle':'オラクル 1 パス',
    'noise-all':'雑音 全','noise-fine':'雑音 細','noise-coarse':'雑音 粗','noise-leak':'raw 漏れ'};
  const noise=active().noise;
  const shown=categories.filter(value=>!value.startsWith('noise-')||noise);
  buttons('kinds',shown.map(value=>({value,label:labels[value]})),kind,value=>{kind=value;selected=null;draw();});
  const hasLevel=['L','L-minus-b','sample-L'].includes(kind);
  const hasNu=['level-bal','over','oracle','oracle-minus-b','sample-oracle'].includes(kind);
  const levels=Array.from({length:report.lmax??0},(_,index)=>String(index+1));
  buttons('levels',hasLevel?levels:[],String(level),value=>{level=Number(value);draw();});
  const nus=Object.keys(report.groups??{});
  if(!nus.includes(nu))nu=nus[0]??'';
  buttons('nus',hasNu?nus:[],nu,value=>{nu=value;draw();});
  const hasTarget=kind.startsWith('noise-');
  const targets=hasTarget?Object.keys(noise?.targets??{}).filter(value=>kind!=='noise-leak'||value!=='L0'):[];
  if(!targets.includes(target))target=targets[0]??'production';
  buttons('targets',targets.map(value=>({value,label:value==='production'?'本番':value.replace('L','段 ')})),target,value=>{target=value;draw();});
  const settings=report.settings??{};
  const descriptions={b:'段 0 の収束平均。基準像 B。',production:'本番の読む段で合成した収束平均。',
    'sample-production':'本番の 1 パス。','sample-L0':'段 0 の 1 パス。',
    'level-production':'本番で画素ごとに選んだ段。','production-minus-b':'本番像と基準像 B の差。',
    L:'固定段から読む収束平均。','L-minus-b':'固定段像と基準像 B の差。',
    'sample-L':'固定段の 1 パス。','level-bal':'局所構造誤差と雑音の重み付き和が最小になる段。',
    over:'本番が釣り合い段より何段粗いか。','oracle':'釣り合い段を画素ごとに選んだ合成像。',
    'oracle-minus-b':'釣り合い段像と基準像 B の差。','sample-oracle':'釣り合い段を使った 1 パス。',
    'noise-all':'画素ごとの 1 パス雑音（8 seed の RMS）。N の出どころ。全種類同じ倍率で、暗い所が読めるよう平方根の階調で表示する。',
    'noise-fine':'8×8 ブロックの平均を引いた残りの雑音。8 px より細かい尺度。',
    'noise-coarse':'8×8 ブロックの平均の雑音。N8 の出どころ。',
    'noise-leak':'同じ seed の raw の雑音に対する回帰の傾き（8×8 ごと）。1 に近いほど raw がそのまま漏れている。'};
  document.getElementById('caption').textContent=(descriptions[kind]??'')+'\u3000passes '+(settings.passes??'?')
    +' / graphics '+JSON.stringify(settings.graphics??{})+' / radius '+(settings.radius??'?')
    +' / gain '+JSON.stringify(report.display??{});
  const chosen=pointRows().find(item=>selected===item.series.key+'/'+item.point.key);
  if(chosen){
    const metric=chosen.point.metrics[group];
    document.getElementById('caption').textContent=chosen.series.label+' / '+chosen.point.label
      +(metric?'\u3000S '+metric.S.toExponential(3)+'\u3000N8 '+metric.N8.toExponential(3):'');
  }
  drawImage();
  drawNoiseTable(noise, target);
}
function drawNoiseTable(noise,target){
  const table=document.getElementById('noiseTable');
  table.replaceChildren();
  const rows=Object.entries(noise?.targets?.[target]??{}).filter(([name])=>name==='all/all'||name.startsWith('all/')||name==='no-rim/all'
    ||/^curve-[0-3]\\/lv(3-4|4\\+)$/.test(name)||/^rough-[0-3]\\/all$/.test(name));
  if(!rows.length)return;
  const headings=['組','画素率','energyShare','N','N8','1','2','4','8','16','32+','leak'];
  const header=document.createElement('tr');
  for(const value of headings){const cell=document.createElement('th');cell.textContent=value;header.append(cell);}
  table.append(header);
  for(const [name,row] of rows){
    const values=[name,(100*row.pixels/(960*540)).toFixed(1)+'%',(100*row.energyShare).toFixed(1)+'%',
      row.N.toExponential(3),row.sizes['8'].toExponential(3),...['1','2','4','8','16','32+'].map(key=>(100*row.shares[key]).toFixed(1)+'%'),row.leak.toFixed(3)];
    const tr=document.createElement('tr');
    for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    table.append(tr);
  }
}
function svgElement(name,attributes={},content=''){
  const node=document.createElementNS('http://www.w3.org/2000/svg',name);
  for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);
  node.textContent=content;
  return node;
}
draw();
</script>`;
writeFileSync(path.join(root, 'index.html'), html);
