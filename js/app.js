
import { canvasToBlob, cloneProjectData } from './storage-utils.js';
import { registerServiceWorker } from './pwa.js';

// ================================================================
//  STATE
// ================================================================
const S = {
  tool:'draw', brushType:'round',
  color:{h:0,s:0,v:0.1,a:1},
  brushSize:20, opacity:1, flow:0.8, hardness:0.5,
  zoom:1, isDrawing:false,
  lastX:0, lastY:0,
  history:[], historyIndex:-1,
  layers:[], activeLayer:0,
  frames:[], currentFrame:0,
  canvasW:800, canvasH:600,
  canvasName:'Sin título', projectId:null,
  profile:{name:'',age:null,mode:'auto'},
  symmetry:false,
  palette:['#e63946','#ff9f1c','#2ec4b6','#3a86ff','#8338ec','#ff006e','#fb5607','#06d6a0','#118ab2','#ffd166'],
  selectedSticker:'⭐', stickerSize:60,
  animPlaying:false, animFPS:6, animTimer:null, onionSkin:false,
  theme:'dark',
  activeFilter:{bright:0,contrast:0,sat:0,blur:0},
  dirty:false,
  pointerId:null, pointerPressure:1,
  pendingLayerBefore:null, lastFullSnapshot:null,
  profileMode:'studio',
};
const MAX_HIST = 24;
const DB_NAME='EstudioArteDB';
const DB_VERSION=1;
const AUTOSAVE_KEY='autosave';

// ================================================================
//  THEME
// ================================================================
function updateThemeButtons(){
  const isDark=S.theme==='dark';
  document.querySelectorAll('#themeToggle,#startThemeToggle').forEach(btn=>{
    if(!btn) return;
    btn.textContent=isDark ? '🌙' : '🌞';
    btn.setAttribute('aria-pressed',String(!isDark));
  });
}
document.getElementById('themeToggle').addEventListener('click', () => {
  S.theme = S.theme === 'dark' ? 'kids' : 'dark';
  document.body.setAttribute('data-theme', S.theme);
  updateThemeButtons();
});

function setModalVisible(id, visible){
  const modal=document.getElementById(id);
  if(!modal) return;
  modal.classList.toggle('show',visible);
  modal.setAttribute('aria-hidden',String(!visible));
  if(visible){
    const first=modal.querySelector('button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
    first?.focus();
  }
}
function openModal(id){setModalVisible(id,true);}
function closeModal(id){setModalVisible(id,false);}
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  document.querySelectorAll('.modal-overlay.show').forEach(modal=>closeModal(modal.id));
});

// ================================================================
//  CANVAS INIT
// ================================================================
const canvasEl = document.getElementById('drawingCanvas');
const canvasWrap = document.getElementById('canvasWrap');
const canvasCont = document.getElementById('canvasContainer');

function createEmptyLayer(name, w=S.canvasW, h=S.canvasH){
  const lc=document.createElement('canvas');
  lc.width=w; lc.height=h;
  return {canvas:lc, name:name||'Capa', visible:true, opacity:1, blendMode:'source-over'};
}
function cloneLayer(L){
  const nl=createEmptyLayer(L.name, S.canvasW, S.canvasH);
  nl.visible=L.visible; nl.opacity=L.opacity; nl.blendMode=L.blendMode;
  nl.canvas.getContext('2d').drawImage(L.canvas,0,0);
  return nl;
}
function makeBlankFrame(name){
  const bg=createEmptyLayer('Fondo', S.canvasW, S.canvasH);
  const bgc=bg.canvas.getContext('2d'); bgc.fillStyle='#ffffff'; bgc.fillRect(0,0,S.canvasW,S.canvasH);
  return {name:name||'Frame 1', layers:[bg]};
}
function bindCurrentFrame(){
  if(!S.frames.length) S.frames=[{name:'Frame 1', layers:S.layers}];
  S.frames[S.currentFrame].layers=S.layers;
}
function switchFrame(idx){
  if(idx<0||idx>=S.frames.length) return;
  bindCurrentFrame();
  S.currentFrame=idx;
  S.layers=S.frames[idx].layers;
  S.activeLayer=Math.min(S.activeLayer,S.layers.length-1);
  renderAll(); updateLayersPanel(); buildFrameStrip(); scheduleAutosave();
}
function initCanvas(w, h, keepLayers) {
  S.canvasW=w; S.canvasH=h;
  canvasEl.width=w; canvasEl.height=h;
  canvasEl.style.width=w+'px'; canvasEl.style.height=h+'px';
  canvasCont.style.width=w+'px'; canvasCont.style.height=h+'px';
  document.getElementById('symLine').style.left=(w/2)+'px';
  if(!keepLayers){
    S.frames=[];
    S.layers=[];
    S.layers=makeBlankFrame('Frame 1').layers;
    S.frames.push({name:'Frame 1', layers:S.layers});
    S.currentFrame=0; S.activeLayer=0;
  }
  S.history=[]; S.historyIndex=-1; S.lastFullSnapshot=null;
  saveState('init'); renderAll(); updateLayersPanel(); fitScreen(); scheduleAutosave();
}
function addLayer(name, silent){
  const lc=createEmptyLayer(name||'Capa '+(S.layers.length+1));
  S.layers.push(lc);
  if(S.layers.length>1) S.activeLayer=S.layers.length-1;
  bindCurrentFrame();
  if(!silent){updateLayersPanel(); renderAll(); saveState('layer-add'); scheduleAutosave();}
}
function getLayerCtx(i){ return S.layers[i].canvas.getContext('2d'); }
function compositeLayersToCanvas(layers, includeHidden=false){
  const out=document.createElement('canvas'); out.width=S.canvasW; out.height=S.canvasH;
  const ctx=out.getContext('2d');
  for(let i=0;i<layers.length;i++){
    const L=layers[i]; if(!includeHidden && !L.visible) continue;
    ctx.globalAlpha=L.opacity; ctx.globalCompositeOperation=L.blendMode;
    ctx.drawImage(L.canvas,0,0);
  }
  ctx.globalAlpha=1; ctx.globalCompositeOperation='source-over';
  return out;
}
function renderAll(){
  const ctx=canvasEl.getContext('2d');
  ctx.clearRect(0,0,S.canvasW,S.canvasH);
  if(S.onionSkin && S.currentFrame>0 && S.frames[S.currentFrame-1]){
    const prev=compositeLayersToCanvas(S.frames[S.currentFrame-1].layers);
    ctx.globalAlpha=0.22; ctx.drawImage(prev,0,0); ctx.globalAlpha=1;
  }
  const comp=compositeLayersToCanvas(S.layers);
  ctx.drawImage(comp,0,0);
  updateLayerThumbs(); buildFrameStrip();
}
function fitScreen(){
  const ww=canvasWrap.clientWidth-40, wh=canvasWrap.clientHeight-40;
  S.zoom=Math.min(ww/S.canvasW, wh/S.canvasH, 2);
  applyZoom();
}
function applyZoom(){
  canvasCont.style.transform=`scale(${S.zoom})`;
  const zoomLabel=document.getElementById('zoomLbl');
  zoomLabel.textContent=Math.round(S.zoom*100)+'%';
  zoomLabel.setAttribute('aria-label','Zoom '+zoomLabel.textContent);
}

// ================================================================
//  HISTORY — lightweight per-frame/layer commands
// ================================================================
function layerToState(L){return {name:L.name,visible:L.visible,opacity:L.opacity,blendMode:L.blendMode,data:L.canvas.toDataURL('image/png')}}
function layerMetaState(L){return {name:L.name,visible:L.visible,opacity:L.opacity,blendMode:L.blendMode};}
async function layerToBlobState(L){
  const state=layerMetaState(L);
  state.blob=await canvasToBlob(L.canvas,'image/png');
  return state;
}
async function snapshotProjectForDB(){
  bindCurrentFrame();
  const frames=[];
  for(let idx=0; idx<S.frames.length; idx++){
    const F=S.frames[idx];
    frames.push({name:F.name||('Frame '+(idx+1)),layers:await Promise.all(F.layers.map(layerToBlobState))});
  }
  return {w:S.canvasW,h:S.canvasH,name:S.canvasName,currentFrame:S.currentFrame,activeLayer:S.activeLayer,frames};
}
function snapshotProject(){
  bindCurrentFrame();
  return {
    w:S.canvasW,h:S.canvasH,name:S.canvasName,currentFrame:S.currentFrame,activeLayer:S.activeLayer,
    frames:S.frames.map((F,idx)=>({name:F.name||('Frame '+(idx+1)),layers:F.layers.map(layerToState)}))
  };
}
function updateHistInfo(){document.getElementById('histInfo').textContent=`↩ ${S.historyIndex}/${Math.max(0,S.history.length-1)}`;}
function captureLayerBefore(reason='edit'){
  if(!S.layers[S.activeLayer]) return;
  S.pendingLayerBefore={
    reason, frameIndex:S.currentFrame, layerIndex:S.activeLayer,
    state:layerToState(S.layers[S.activeLayer])
  };
}
function patchLastSnapshotLayer(frameIndex, layerIndex, state){
  if(!S.lastFullSnapshot || !S.lastFullSnapshot.frames?.[frameIndex]?.layers?.[layerIndex]) return;
  S.lastFullSnapshot.frames[frameIndex].layers[layerIndex]=cloneProjectData(state);
  S.lastFullSnapshot.currentFrame=S.currentFrame;
  S.lastFullSnapshot.activeLayer=S.activeLayer;
  S.lastFullSnapshot.name=S.canvasName;
}
function pushHistoryCommand(cmd){
  S.historyIndex++;
  if(S.historyIndex<S.history.length) S.history=S.history.slice(0,S.historyIndex);
  S.history.push(cmd);
  if(S.history.length>MAX_HIST){S.history.shift();S.historyIndex=Math.max(0,S.historyIndex-1);}
  updateHistInfo();
  scheduleAutosave();
}
function saveState(reason='edit'){
  const before=S.pendingLayerBefore;
  if(before && before.frameIndex===S.currentFrame && before.layerIndex===S.activeLayer && S.layers[S.activeLayer]){
    const after=layerToState(S.layers[S.activeLayer]);
    pushHistoryCommand({type:'layer',reason,frameIndex:S.currentFrame,layerIndex:S.activeLayer,before:before.state,after});
    patchLastSnapshotLayer(S.currentFrame,S.activeLayer,after);
    S.pendingLayerBefore=null;
    return;
  }
  S.pendingLayerBefore=null;
  const after=snapshotProject();
  const cmd={type:'project',reason,before:cloneProjectData(S.lastFullSnapshot),after:cloneProjectData(after)};
  S.lastFullSnapshot=cloneProjectData(after);
  pushHistoryCommand(cmd);
}
async function applyLayerState(frameIndex, layerIndex, state){
  bindCurrentFrame();
  if(!S.frames[frameIndex]) return;
  S.currentFrame=frameIndex;
  S.layers=S.frames[frameIndex].layers;
  if(!S.layers[layerIndex]) return;
  const L=S.layers[layerIndex];
  L.name=state.name||'Capa'; L.visible=state.visible!==false; L.opacity=state.opacity??1; L.blendMode=state.blendMode||'source-over';
  L.canvas.width=S.canvasW; L.canvas.height=S.canvasH;
  const ctx=L.canvas.getContext('2d'); ctx.clearRect(0,0,S.canvasW,S.canvasH);
  if(state.data){const img=await loadImage(state.data); ctx.drawImage(img,0,0);}
  S.activeLayer=Math.min(layerIndex,S.layers.length-1);
  patchLastSnapshotLayer(frameIndex,layerIndex,state);
  renderAll(); updateLayersPanel(); buildFrameStrip(); updateHistInfo();
}
async function undo(){
  if(S.historyIndex<=0) return;
  const cmd=S.history[S.historyIndex];
  if(cmd.type==='layer'){
    await applyLayerState(cmd.frameIndex,cmd.layerIndex,cmd.before);
  }else if(cmd.type==='project' && cmd.before){
    await applyProjectData(cmd.before,{preserveId:true,skipHistory:true});
    S.lastFullSnapshot=cloneProjectData(cmd.before);
  }
  S.historyIndex--; updateHistInfo(); scheduleAutosave();
}
async function redo(){
  if(S.historyIndex>=S.history.length-1) return;
  S.historyIndex++;
  const cmd=S.history[S.historyIndex];
  if(cmd.type==='layer'){
    await applyLayerState(cmd.frameIndex,cmd.layerIndex,cmd.after);
  }else if(cmd.type==='project'){
    await applyProjectData(cmd.after,{preserveId:true,skipHistory:true});
    S.lastFullSnapshot=cloneProjectData(cmd.after);
  }
  updateHistInfo(); scheduleAutosave();
}
function loadImage(src){return new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=src;});}
async function drawLayerSource(ctx, ldata){
  const src=ldata.data||ldata.blob;
  if(!src) return;
  const isBlob=src instanceof Blob;
  const url=isBlob ? URL.createObjectURL(src) : src;
  try{
    const img=await loadImage(url);
    ctx.drawImage(img,0,0);
  }finally{
    if(isBlob) URL.revokeObjectURL(url);
  }
}
async function restoreSnap(snap){
  await applyProjectData(snap,{preserveId:true,skipHistory:true});
  S.lastFullSnapshot=cloneProjectData(snap); updateHistInfo();
}
async function applyProjectData(d,{preserveId=false,skipHistory=false}={}){
  S.canvasW=d.w; S.canvasH=d.h; S.canvasName=d.name||'Sin título';
  document.getElementById('canvasName').textContent=S.canvasName;
  canvasEl.width=d.w; canvasEl.height=d.h; canvasEl.style.width=d.w+'px'; canvasEl.style.height=d.h+'px';
  canvasCont.style.width=d.w+'px'; canvasCont.style.height=d.h+'px';
  document.getElementById('symLine').style.left=(d.w/2)+'px';
  S.frames=[];
  const frames=d.frames || [{name:'Frame 1', layers:d.layers||[]}];
  for(let fi=0; fi<frames.length; fi++){
    const F=frames[fi]; const layers=[];
    for(const ldata of F.layers){
      const c=document.createElement('canvas'); c.width=d.w; c.height=d.h;
      await drawLayerSource(c.getContext('2d'),ldata);
      layers.push({canvas:c,name:ldata.name||'Capa',visible:ldata.visible!==false,opacity:ldata.opacity??1,blendMode:ldata.blendMode||'source-over'});
    }
    if(!layers.length) layers.push(makeBlankFrame('Frame '+(fi+1)).layers[0]);
    S.frames.push({name:F.name||('Frame '+(fi+1)),layers});
  }
  S.currentFrame=Math.min(d.currentFrame||0,S.frames.length-1);
  S.layers=S.frames[S.currentFrame].layers;
  S.activeLayer=Math.min(d.activeLayer||0,S.layers.length-1);
  if(!preserveId) S.projectId=d.id||S.projectId||('project-'+Date.now());
  renderAll(); updateLayersPanel(); buildFrameStrip(); fitScreen();
  if(!skipHistory){S.history=[];S.historyIndex=-1;S.lastFullSnapshot=null;saveState('load');}
}

// ================================================================
//  COLOR
// ================================================================
function hsv2rgb(h,s,v){let r,g,b,i=Math.floor(h*6),f=h*6-i,p=v*(1-s),q=v*(1-f*s),t=v*(1-(1-f)*s);switch(i%6){case 0:r=v;g=t;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t;break;case 3:r=p;g=q;b=v;break;case 4:r=t;g=p;b=v;break;case 5:r=v;g=p;b=q;break;}return{r:Math.round(r*255),g:Math.round(g*255),b:Math.round(b*255)};}
function rgb2hex(r,g,b){return'#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');}
function hex2rgb(h){return{r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16)};}
function rgb2hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0,s=mx===0?0:d/mx,v=mx;if(d){switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;}h/=6;}return{h,s,v};}
function curHex(){const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);return rgb2hex(r,g,b);}

function updateColorUI(){
  const hex=curHex();
  document.getElementById('hexInput').value=hex;
  document.getElementById('colorPreview').style.background=hex;
  drawHSV(); drawHue(); drawOpacity(); drawFgSwatch();
}

function drawHSV(){
  const el=document.getElementById('hsvCanvas');
  const w=el.parentElement.clientWidth||196, h=w;
  el.width=w; el.height=h;
  const ctx=el.getContext('2d');
  const gH=ctx.createLinearGradient(0,0,w,0);
  gH.addColorStop(0,'#fff');
  const{r,g,b}=hsv2rgb(S.color.h,1,1);
  gH.addColorStop(1,`rgb(${r},${g},${b})`);
  ctx.fillStyle=gH; ctx.fillRect(0,0,w,h);
  const gV=ctx.createLinearGradient(0,0,0,h);
  gV.addColorStop(0,'rgba(0,0,0,0)'); gV.addColorStop(1,'#000');
  ctx.fillStyle=gV; ctx.fillRect(0,0,w,h);
  const hnd=document.getElementById('hsvHandle');
  hnd.style.left=(S.color.s*w)+'px'; hnd.style.top=((1-S.color.v)*h)+'px';
  hnd.style.background=curHex();
}
function drawHue(){
  const el=document.getElementById('hueCanvas');
  const w=el.parentElement.clientWidth||196;
  el.width=w; el.height=14;
  const ctx=el.getContext('2d');
  const g=ctx.createLinearGradient(0,0,w,0);
  for(let i=0;i<=360;i+=30) g.addColorStop(i/360,`hsl(${i},100%,50%)`);
  ctx.fillStyle=g; ctx.fillRect(0,0,w,14);
  document.getElementById('hueHandle').style.left=(S.color.h*w)+'px';
}
function drawOpacity(){
  const el=document.getElementById('opacityCanvas');
  const w=el.parentElement.clientWidth||196;
  el.width=w; el.height=14;
  const ctx=el.getContext('2d');
  for(let x=0;x<w;x+=7){const e=Math.floor(x/7)%2===0;ctx.fillStyle=e?'#bbb':'#888';ctx.fillRect(x,0,7,14);}
  const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);
  const g2=ctx.createLinearGradient(0,0,w,0);
  g2.addColorStop(0,`rgba(${r},${g},${b},0)`); g2.addColorStop(1,`rgba(${r},${g},${b},1)`);
  ctx.fillStyle=g2; ctx.fillRect(0,0,w,14);
  document.getElementById('opacityHandle').style.left=(S.color.a*w)+'px';
}
function drawFgSwatch(){
  const el=document.getElementById('fgSwatch');
  const ctx=el.getContext('2d'); ctx.clearRect(0,0,26,26);
  ctx.beginPath(); ctx.arc(13,13,11,0,Math.PI*2);
  ctx.fillStyle=curHex(); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=1.5; ctx.stroke();
}

// Color picker drag
let hsvDrag=false,hueDrag=false,opDrag=false;
function setupColorPicker(){
  const hsvEl=document.getElementById('hsvPicker');
  const hueEl=document.getElementById('hueSlider');
  const opEl=document.getElementById('opacitySlider');
  let activeColorDrag=null;
  function pointFromPointer(e){return e;}
  function onHSV(e){const r=document.getElementById('hsvCanvas').getBoundingClientRect();const p=pointFromPointer(e);S.color.s=Math.max(0,Math.min(1,(p.clientX-r.left)/r.width));S.color.v=1-Math.max(0,Math.min(1,(p.clientY-r.top)/r.height));updateColorUI();}
  function onHue(e){const r=document.getElementById('hueCanvas').getBoundingClientRect();const p=pointFromPointer(e);S.color.h=Math.max(0,Math.min(1,(p.clientX-r.left)/r.width));updateColorUI();}
  function onOp(e){const r=document.getElementById('opacityCanvas').getBoundingClientRect();const p=pointFromPointer(e);S.color.a=Math.max(0,Math.min(1,(p.clientX-r.left)/r.width));updateColorUI();}
  function start(kind,handler,el,e){e.preventDefault();activeColorDrag={kind,handler,id:e.pointerId};try{el.setPointerCapture(e.pointerId);}catch(_){ }handler(e);}
  hsvEl.addEventListener('pointerdown',e=>start('hsv',onHSV,hsvEl,e));
  hueEl.addEventListener('pointerdown',e=>start('hue',onHue,hueEl,e));
  opEl.addEventListener('pointerdown',e=>start('op',onOp,opEl,e));
  [hsvEl,hueEl,opEl].forEach(el=>{
    el.addEventListener('pointermove',e=>{if(!activeColorDrag||activeColorDrag.id!==e.pointerId)return;e.preventDefault();activeColorDrag.handler(e);});
    el.addEventListener('pointerup',()=>{activeColorDrag=null;});
    el.addEventListener('pointercancel',()=>{activeColorDrag=null;});
  });
  document.getElementById('hexInput').addEventListener('change',e=>{
    let v=e.target.value.trim(); if(!v.startsWith('#'))v='#'+v;
    if(/^#[0-9a-fA-F]{6}$/.test(v)){const{r,g,b}=hex2rgb(v);const hsv=rgb2hsv(r,g,b);S.color.h=hsv.h;S.color.s=hsv.s;S.color.v=hsv.v;updateColorUI();}
  });
}

function buildPalette(){
  const row=document.getElementById('paletteRow'); row.innerHTML='';
  S.palette.forEach((hex,idx)=>{
    const d=document.createElement('div'); d.className='pal-dot'; d.style.background=hex;
    d.title='Clic: usar  |  Clic derecho: reemplazar';
    d.addEventListener('click',()=>{const{r,g,b}=hex2rgb(hex);const hsv=rgb2hsv(r,g,b);S.color.h=hsv.h;S.color.s=hsv.s;S.color.v=hsv.v;updateColorUI();});
    d.addEventListener('contextmenu',e=>{e.preventDefault();S.palette[idx]=curHex();buildPalette();});
    row.appendChild(d);
  });
  const add=document.createElement('div'); add.className='pal-dot pal-add'; add.textContent='+';
  add.addEventListener('click',()=>{S.palette.push(curHex());buildPalette();});
  row.appendChild(add);
}

// ================================================================
//  BRUSH SYSTEM
// ================================================================
const brushDefs=[
  {id:'round',name:'Suave',icon:'●'},
  {id:'hard',name:'Duro',icon:'⬤'},
  {id:'flat',name:'Plano',icon:'▬'},
  {id:'spray',name:'Spray',icon:'💨'},
  {id:'chalk',name:'Tiza',icon:'✏️'},
  {id:'watercolor',name:'Agua',icon:'💧'},
  {id:'pencil',name:'Lápiz',icon:'✒️'},
  {id:'glow',name:'Neón',icon:'✨'},
];

function buildBrushGrid(){
  const g=document.getElementById('brushGrid'); g.innerHTML='';
  brushDefs.forEach(br=>{
    const c=document.createElement('div'); c.className='brush-card'+(S.brushType===br.id?' active':'');
    const pc=document.createElement('canvas'); pc.width=40; pc.height=30;
    drawBrushPreviewIcon(pc.getContext('2d'), br.id, 40, 30);
    c.innerHTML=`<span style="font-size:14px">${br.icon}</span><div class="brush-card-name">${br.name}</div>`;
    c.addEventListener('click',()=>{S.brushType=br.id;document.querySelectorAll('.brush-card').forEach(b=>b.classList.remove('active'));c.classList.add('active');});
    g.appendChild(c);
  });
}
function drawBrushPreviewIcon(ctx,id,w,h){
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#888';
  switch(id){
    case 'round':{const g=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,10);g.addColorStop(0,'#aaa');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(w/2,h/2,10,0,Math.PI*2);ctx.fill();break;}
    case 'hard':ctx.fillStyle='#aaa';ctx.beginPath();ctx.arc(w/2,h/2,9,0,Math.PI*2);ctx.fill();break;
    case 'flat':ctx.fillStyle='#aaa';ctx.fillRect(w/2-10,h/2-4,20,8);break;
    case 'spray':ctx.fillStyle='#888';for(let i=0;i<25;i++){ctx.beginPath();ctx.arc(w/2+(Math.cos(i*1.5)*8),h/2+(Math.sin(i*1.5)*6),1,0,Math.PI*2);ctx.fill();}break;
    case 'chalk':ctx.fillStyle='#888';for(let i=0;i<4;i++){ctx.globalAlpha=0.5+Math.random()*0.5;ctx.fillRect(w/2-8+i*4,h/2-3+Math.random()*2,2+Math.random()*2,6);}ctx.globalAlpha=1;break;
    case 'watercolor':ctx.globalAlpha=0.3;for(let i=0;i<5;i++){ctx.fillStyle='#6ab';ctx.beginPath();ctx.arc(w/2+Math.cos(i)*6,h/2+Math.sin(i)*5,6,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;break;
    case 'pencil':ctx.globalAlpha=0.6;for(let i=0;i<3;i++){ctx.strokeStyle='#aaa';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(w/2-9,h/2-3+i*3);ctx.lineTo(w/2+9,h/2-3+i*3);ctx.stroke();}ctx.globalAlpha=1;break;
    case 'glow':{const g=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,12);g.addColorStop(0,'rgba(180,100,255,1)');g.addColorStop(0.5,'rgba(100,150,255,0.5)');g.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=g;ctx.beginPath();ctx.arc(w/2,h/2,12,0,Math.PI*2);ctx.fill();break;}
  }
}

// ================================================================
//  DRAWING ENGINE
// ================================================================
function getEventPoint(e){
  if(e.touches && e.touches.length) return e.touches[0];
  if(e.changedTouches && e.changedTouches.length) return e.changedTouches[0];
  return e;
}
function getPressure(e){
  if(e && typeof e.pressure==='number' && e.pointerType==='pen') return Math.max(0.12,Math.min(1,e.pressure||0.35));
  return 1;
}
function getPos(e){
  const rect=canvasEl.getBoundingClientRect();
  const sx=canvasEl.width/rect.width, sy=canvasEl.height/rect.height;
  const p=getEventPoint(e);
  return{x:(p.clientX-rect.left)*sx, y:(p.clientY-rect.top)*sy};
}
function getDrawCtx(){ return S.layers[S.activeLayer].canvas.getContext('2d'); }
function effectiveBrushSize(){return Math.max(1,S.brushSize*(0.35+0.65*(S.pointerPressure||1)));}
function effectiveFlowAlpha(){return S.opacity*S.flow*(0.45+0.55*(S.pointerPressure||1));}
function isMutatingTool(){return ['draw','pencil','spray','chalk','watercolor','line','rect','ellipse','fill','text','sticker','eraser','smudge'].includes(S.tool);}

function startDraw(e){
  if(e.pointerId!=null){
    if(S.pointerId!==null && S.pointerId!==e.pointerId) return;
    S.pointerId=e.pointerId;
    try{canvasEl.setPointerCapture(e.pointerId);}catch(_){ }
  }
  S.pointerPressure=getPressure(e);
  if(e.cancelable) e.preventDefault();
  const pos=getPos(e);
  if(S.tool==='eyedropper'){pickColor(pos);return;}
  if(isMutatingTool()) captureLayerBefore(S.tool);
  if(S.tool==='fill'){doFill(pos.x,pos.y);return;}
  if(S.tool==='text'){placeText(pos);return;}
  if(S.tool==='sticker'){placeSticker(pos);return;}
  if(['line','rect','ellipse'].includes(S.tool)){S.shapStart={x:pos.x,y:pos.y};S.isDrawing=true;return;}
  S.isDrawing=true; S.lastX=pos.x; S.lastY=pos.y;
  applyDot(getDrawCtx(),pos.x,pos.y); renderAll();
}

function moveDraw(e){
  if(e.pointerId!=null && S.pointerId!==null && e.pointerId!==S.pointerId) return;
  S.pointerPressure=getPressure(e);
  const pos=getPos(e);
  document.getElementById('posInfo').textContent=`x:${Math.round(pos.x)} y:${Math.round(pos.y)} p:${Math.round((S.pointerPressure||1)*100)}%`;
  const ring=document.getElementById('cursorRing');
  const ep=getEventPoint(e);
  ring.style.display='block'; ring.style.left=ep.clientX+'px'; ring.style.top=ep.clientY+'px';
  const sz=Math.max(6,effectiveBrushSize()*S.zoom);
  ring.style.width=sz+'px'; ring.style.height=sz+'px';
  if(!S.isDrawing) return;
  if(e.cancelable) e.preventDefault();
  if(['line','rect','ellipse'].includes(S.tool) && S.shapStart){previewShape(pos);return;}
  const ctx=getDrawCtx();
  applyStroke(ctx,S.lastX,S.lastY,pos.x,pos.y);
  if(S.symmetry){
    const mx=S.canvasW-pos.x, mx0=S.canvasW-S.lastX;
    applyStroke(ctx,mx0,S.lastY,mx,pos.y);
  }
  S.lastX=pos.x; S.lastY=pos.y; renderAll();
}

function endDraw(e){
  if(e && e.pointerId!=null && S.pointerId!==null && e.pointerId!==S.pointerId) return;
  if(e && e.pointerId!=null){try{canvasEl.releasePointerCapture(e.pointerId);}catch(_){ }}
  S.pointerId=null;
  if(!S.isDrawing) {document.getElementById('cursorRing').style.display='none'; return;}
  S.pointerPressure=getPressure(e||{});
  S.isDrawing=false;
  if(['line','rect','ellipse'].includes(S.tool) && S.shapStart){
    if(e){const pos=getPos(e);commitShape(pos);} 
    S.shapStart=null;
    return;
  }
  saveState('draw');
}

// Dot
function applyDot(ctx,x,y){
  if(S.tool==='eraser'){eraseAt(ctx,x,y);return;}
  const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);
  const alpha=effectiveFlowAlpha();
  brushDot(ctx,x,y,r,g,b,alpha,effectiveBrushSize(),S.hardness,S.brushType);
}

function brushDot(ctx,x,y,r,g,b,alpha,sz,hard,type){
  ctx.save();
  switch(type){
    case 'round':{
      const soft=1-hard*0.8;
      const g2=ctx.createRadialGradient(x,y,0,x,y,sz/2);
      g2.addColorStop(soft,`rgba(${r},${g},${b},${alpha})`);
      g2.addColorStop(1,`rgba(${r},${g},${b},0)`);
      ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(x,y,sz/2,0,Math.PI*2); ctx.fill(); break;
    }
    case 'hard':
      ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath(); ctx.arc(x,y,sz/2,0,Math.PI*2); ctx.fill(); break;
    case 'flat':
      ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`;
      ctx.save(); ctx.translate(x,y);
      ctx.fillRect(-sz/2,-sz*0.25,sz,sz*0.5); ctx.restore(); break;
    case 'spray':
      for(let i=0;i<Math.floor(sz*2.5);i++){
        const a=Math.random()*Math.PI*2, d=Math.random()*sz*0.7;
        ctx.fillStyle=`rgba(${r},${g},${b},${alpha*0.15})`;
        ctx.beginPath(); ctx.arc(x+Math.cos(a)*d,y+Math.sin(a)*d,0.8,0,Math.PI*2); ctx.fill();
      } break;
    case 'chalk':
      for(let i=0;i<7;i++){
        const ox=(Math.random()-0.5)*sz*0.5, oy=(Math.random()-0.5)*sz*0.5;
        ctx.fillStyle=`rgba(${r},${g},${b},${alpha*(0.3+Math.random()*0.4)})`;
        ctx.fillRect(x+ox-sz*0.12,y+oy-sz*0.1,sz*0.25+Math.random()*sz*0.15,sz*0.05+Math.random()*sz*0.1);
      } break;
    case 'watercolor':
      for(let i=0;i<5;i++){
        const ox=(Math.random()-0.5)*sz*0.5, oy=(Math.random()-0.5)*sz*0.5;
        const g2=ctx.createRadialGradient(x+ox,y+oy,0,x+ox,y+oy,sz*(0.35+Math.random()*0.25));
        g2.addColorStop(0,`rgba(${r},${g},${b},${alpha*0.25})`);
        g2.addColorStop(1,`rgba(${r},${g},${b},0)`);
        ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(x+ox,y+oy,sz*(0.35+Math.random()*0.25),0,Math.PI*2); ctx.fill();
      } break;
    case 'pencil':
      for(let i=0;i<4;i++){
        const oy=(Math.random()-0.5)*sz*0.15;
        ctx.strokeStyle=`rgba(${r},${g},${b},${alpha*(0.4+Math.random()*0.35)})`;
        ctx.lineWidth=0.4+Math.random()*1.2; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(x-sz*0.3,y+oy); ctx.lineTo(x+sz*0.3,y+oy); ctx.stroke();
      } break;
    case 'glow':{
      ctx.shadowColor=`rgba(${r},${g},${b},0.9)`; ctx.shadowBlur=sz*0.8;
      const g2=ctx.createRadialGradient(x,y,0,x,y,sz/2);
      g2.addColorStop(0,`rgba(${r},${g},${b},${alpha})`);
      g2.addColorStop(1,`rgba(${r},${g},${b},0)`);
      ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(x,y,sz/2,0,Math.PI*2); ctx.fill();
      ctx.shadowBlur=0; break;
    }
    default:
      ctx.fillStyle=`rgba(${r},${g},${b},${alpha})`;
      ctx.beginPath(); ctx.arc(x,y,sz/2,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

function eraseAt(ctx,x,y){
  ctx.globalCompositeOperation='destination-out';
  ctx.fillStyle=`rgba(255,255,255,${S.opacity})`;
  ctx.beginPath(); ctx.arc(x,y,effectiveBrushSize()/2,0,Math.PI*2); ctx.fill();
  ctx.globalCompositeOperation='source-over';
}

function applyStroke(ctx,x0,y0,x1,y1){
  if(S.tool==='eraser'){
    ctx.globalCompositeOperation='destination-out';
    ctx.strokeStyle=`rgba(255,255,255,${S.opacity})`;
    ctx.lineWidth=effectiveBrushSize(); ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    ctx.globalCompositeOperation='source-over'; return;
  }
  if(S.tool==='smudge'){smudgeAt(ctx,x0,y0,x1,y1);return;}
  const dist=Math.hypot(x1-x0,y1-y0);
  const sz=effectiveBrushSize();
  const steps=Math.max(1,Math.floor(dist/(sz*0.2)));
  const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);
  for(let i=0;i<=steps;i++){
    const t=i/steps;
    brushDot(ctx,x0+(x1-x0)*t,y0+(y1-y0)*t,r,g,b,effectiveFlowAlpha(),sz,S.hardness,S.brushType);
  }
}

function smudgeAt(ctx,x0,y0,x1,y1){
  const s=Math.floor(S.brushSize*1.5);
  try{const d=ctx.getImageData(Math.round(x0-s/2),Math.round(y0-s/2),s,s);ctx.putImageData(d,Math.round(x1-s/2),Math.round(y1-s/2));}catch(e){}
}

// Shape preview
let shapeSnapData=null;
function previewShape(pos){
  if(!shapeSnapData) shapeSnapData=getDrawCtx().getImageData(0,0,S.canvasW,S.canvasH);
  const ctx=getDrawCtx(); ctx.putImageData(shapeSnapData,0,0);
  drawShapeOn(ctx,S.shapStart.x,S.shapStart.y,pos.x,pos.y);
  renderAll();
}
function commitShape(pos){
  if(!shapeSnapData) shapeSnapData=getDrawCtx().getImageData(0,0,S.canvasW,S.canvasH);
  const ctx=getDrawCtx(); ctx.putImageData(shapeSnapData,0,0);
  drawShapeOn(ctx,S.shapStart.x,S.shapStart.y,pos.x,pos.y);
  shapeSnapData=null; renderAll(); saveState();
}
function drawShapeOn(ctx,x0,y0,x1,y1){
  const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);
  ctx.strokeStyle=`rgba(${r},${g},${b},${S.opacity})`; ctx.lineWidth=S.brushSize; ctx.lineCap='round';
  if(S.tool==='line'){ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();}
  if(S.tool==='rect'){ctx.strokeRect(x0,y0,x1-x0,y1-y0);}
  if(S.tool==='ellipse'){ctx.beginPath();ctx.ellipse((x0+x1)/2,(y0+y1)/2,Math.abs(x1-x0)/2,Math.abs(y1-y0)/2,0,0,Math.PI*2);ctx.stroke();}
}

// Flood fill
function doFill(sx,sy){
  const ctx=getDrawCtx();
  const imgData=ctx.getImageData(0,0,S.canvasW,S.canvasH);
  const data=imgData.data; const W=S.canvasW;
  const ix=Math.floor(sx),iy=Math.floor(sy);
  const idx=(iy*W+ix)*4;
  const sR=data[idx],sG=data[idx+1],sB=data[idx+2],sA=data[idx+3];
  const{r,g,b}=hsv2rgb(S.color.h,S.color.s,S.color.v);
  if(sR===r&&sG===g&&sB===b) return;
  const tol=40; const stack=[[ix,iy]]; const vis=new Uint8Array(W*S.canvasH);
  function ok(i){return Math.abs(data[i]-sR)<=tol&&Math.abs(data[i+1]-sG)<=tol&&Math.abs(data[i+2]-sB)<=tol&&Math.abs(data[i+3]-sA)<=tol;}
  while(stack.length){
    const[x,y]=stack.pop(); if(x<0||x>=W||y<0||y>=S.canvasH)continue;
    const i=(y*W+x)*4; if(vis[y*W+x]||!ok(i))continue;
    vis[y*W+x]=1; data[i]=r;data[i+1]=g;data[i+2]=b;data[i+3]=Math.round(S.color.a*255);
    stack.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);
  }
  ctx.putImageData(imgData,0,0); renderAll(); saveState();
}

// Eyedropper
function pickColor(pos){
  const ctx=canvasEl.getContext('2d');
  const d=ctx.getImageData(Math.floor(pos.x),Math.floor(pos.y),1,1).data;
  const hsv=rgb2hsv(d[0],d[1],d[2]);
  S.color.h=hsv.h;S.color.s=hsv.s;S.color.v=hsv.v;S.color.a=d[3]/255;
  updateColorUI(); setTool('draw');
}

// ================================================================
//  TEXT TOOL
// ================================================================
function placeText(pos){
  const ov=document.getElementById('textOverlay');
  const inp=document.createElement('textarea');
  inp.className='text-input-float';
  inp.style.left=pos.x+'px'; inp.style.top=pos.y+'px';
  inp.style.fontSize=(S.brushSize+14)+'px';
  inp.style.color=curHex();
  ov.appendChild(inp); inp.focus();
  inp.addEventListener('blur',()=>{
    if(!inp.value.trim()){ov.removeChild(inp);return;}
    const ctx=getDrawCtx();
    ctx.font=`bold ${S.brushSize+14}px Nunito,sans-serif`;
    ctx.fillStyle=curHex(); ctx.globalAlpha=S.opacity;
    inp.value.split('\n').forEach((line,i)=>ctx.fillText(line,pos.x,pos.y+(S.brushSize+16)*(i+1)));
    ctx.globalAlpha=1; ov.removeChild(inp); renderAll(); saveState();
  });
}

// ================================================================
//  STICKERS
// ================================================================
const STICKERS=['⭐','🌟','💫','✨','🎨','🎭','🦄','🐉','🌈','🔥','💎','🌸','🍀','❤️','💜','🎵','🎸','🚀','🌙','☀️','⚡','🎃','🎄','🦋','🐬','🦁','🐸','🐙','🍦','🍕','🎂','🏆','👑','🎉','🌊'];
function buildStickerPicker(){
  const g=document.getElementById('stickerPicker'); g.innerHTML='';
  STICKERS.forEach(em=>{
    const b=document.createElement('div'); b.className='sticker-btn'+(S.selectedSticker===em?' active':'');
    b.textContent=em;
    b.addEventListener('click',()=>{
      S.selectedSticker=em; setTool('sticker');
      document.querySelectorAll('.sticker-btn').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
    });
    g.appendChild(b);
  });
}
function placeSticker(pos){
  const ctx=getDrawCtx();
  const sz=S.stickerSize;
  ctx.font=`${sz}px serif`;
  ctx.globalAlpha=S.opacity;
  ctx.textBaseline='middle'; ctx.textAlign='center';
  ctx.fillText(S.selectedSticker,pos.x,pos.y);
  ctx.globalAlpha=1; renderAll(); saveState();
}

// ================================================================
//  FILTERS
// ================================================================
const filterDefs=[
  {id:'grayscale',label:'Escala de grises',icon:'⬛'},
  {id:'invert',label:'Invertir',icon:'🔄'},
  {id:'sepia',label:'Sepia',icon:'🟫'},
  {id:'pixelate',label:'Pixelar',icon:'🟦'},
  {id:'vignette',label:'Viñeta',icon:'🔘'},
  {id:'noise',label:'Ruido',icon:'📺'},
];
function buildFilterGrid(){
  const g=document.getElementById('filterGrid'); g.innerHTML='';
  filterDefs.forEach(f=>{
    const b=document.createElement('button'); b.className='filter-btn';
    b.innerHTML=`<span>${f.icon}</span><span>${f.label}</span>`;
    b.addEventListener('click',()=>applyQuickFilter(f.id));
    g.appendChild(b);
  });
}

function applyQuickFilter(id){
  const ctx=getDrawCtx();
  const img=ctx.getImageData(0,0,S.canvasW,S.canvasH);
  const d=img.data;
  if(id==='grayscale'){for(let i=0;i<d.length;i+=4){const g=(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114);d[i]=d[i+1]=d[i+2]=g;}}
  else if(id==='invert'){for(let i=0;i<d.length;i+=4){d[i]=255-d[i];d[i+1]=255-d[i+1];d[i+2]=255-d[i+2];}}
  else if(id==='sepia'){for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];d[i]=Math.min(255,r*0.393+g*0.769+b*0.189);d[i+1]=Math.min(255,r*0.349+g*0.686+b*0.168);d[i+2]=Math.min(255,r*0.272+g*0.534+b*0.131);}}
  else if(id==='pixelate'){
    const ps=Math.max(4,Math.floor(S.brushSize/2));
    for(let y=0;y<S.canvasH;y+=ps)for(let x=0;x<S.canvasW;x+=ps){
      const i=(y*S.canvasW+x)*4;
      const r=d[i],g=d[i+1],b=d[i+2];
      for(let py=0;py<ps&&y+py<S.canvasH;py++)for(let px=0;px<ps&&x+px<S.canvasW;px++){const j=((y+py)*S.canvasW+(x+px))*4;d[j]=r;d[j+1]=g;d[j+2]=b;}
    }
  }
  else if(id==='noise'){for(let i=0;i<d.length;i+=4){const n=(Math.random()-0.5)*60;d[i]=Math.max(0,Math.min(255,d[i]+n));d[i+1]=Math.max(0,Math.min(255,d[i+1]+n));d[i+2]=Math.max(0,Math.min(255,d[i+2]+n));}}
  else if(id==='vignette'){
    const cx=S.canvasW/2,cy=S.canvasH/2,maxD=Math.hypot(cx,cy);
    for(let y=0;y<S.canvasH;y++)for(let x=0;x<S.canvasW;x++){const i=(y*S.canvasW+x)*4;const dist=Math.hypot(x-cx,y-cy)/maxD;const v=1-dist*dist;d[i]=d[i]*v;d[i+1]=d[i+1]*v;d[i+2]=d[i+2]*v;}
  }
  ctx.putImageData(img,0,0); renderAll(); saveState();
}

function applyAdjustments(){
  const bright=parseInt(document.getElementById('brightSlider').value);
  const contrast=parseInt(document.getElementById('contrastSlider').value);
  const sat=parseInt(document.getElementById('satSlider').value);
  const blur=parseInt(document.getElementById('blurSlider').value);
  const ctx=getDrawCtx();
  if(blur>0){
    // Use CSS filter approach via offscreen
    const tmp=document.createElement('canvas'); tmp.width=S.canvasW; tmp.height=S.canvasH;
    const tc=tmp.getContext('2d');
    tc.filter=`blur(${blur}px) brightness(${100+bright}%) contrast(${100+contrast}%) saturate(${100+sat}%)`;
    tc.drawImage(S.layers[S.activeLayer].canvas,0,0);
    ctx.clearRect(0,0,S.canvasW,S.canvasH);
    ctx.drawImage(tmp,0,0);
  } else {
    const img=ctx.getImageData(0,0,S.canvasW,S.canvasH);
    const d=img.data; const bf=bright/100, cf=1+(contrast/100), sf=1+(sat/100);
    for(let i=0;i<d.length;i+=4){
      let r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255;
      // brightness
      r+=bf;g+=bf;b+=bf;
      // contrast
      r=(r-0.5)*cf+0.5;g=(g-0.5)*cf+0.5;b=(b-0.5)*cf+0.5;
      // saturation
      const lum=0.299*r+0.587*g+0.114*b;
      r=lum+(r-lum)*sf;g=lum+(g-lum)*sf;b=lum+(b-lum)*sf;
      d[i]=Math.max(0,Math.min(255,r*255));d[i+1]=Math.max(0,Math.min(255,g*255));d[i+2]=Math.max(0,Math.min(255,b*255));
    }
    ctx.putImageData(img,0,0);
  }
  renderAll(); saveState();
  // Reset sliders
  document.getElementById('brightSlider').value=0; document.getElementById('brightLbl').textContent='0';
  document.getElementById('contrastSlider').value=0; document.getElementById('contrastLbl').textContent='0';
  document.getElementById('satSlider').value=0; document.getElementById('satLbl').textContent='0';
  document.getElementById('blurSlider').value=0; document.getElementById('blurLbl').textContent='0px';
}

// ================================================================
//  TEMPLATES
// ================================================================
const templateDefs=[
  {label:'Dinosaurio',draw:drawDino},
  {label:'Casa',draw:drawHouse},
  {label:'Flor',draw:drawFlower},
  {label:'Cohete',draw:drawRocket},
  {label:'Gato',draw:drawCat},
  {label:'Estrella',draw:drawStar},
];
function buildTemplates(){
  const g=document.getElementById('templateGrid'); g.innerHTML='';
  templateDefs.forEach(t=>{
    const card=document.createElement('div'); card.className='template-card';
    const c=document.createElement('canvas'); c.width=120; c.height=90;
    drawTemplatePreview(c.getContext('2d'),t.draw,120,90);
    card.appendChild(c);
    const lbl=document.createElement('div'); lbl.className='template-card-label'; lbl.textContent=t.label;
    card.appendChild(lbl);
    card.addEventListener('click',()=>loadTemplate(t));
    g.appendChild(card);
  });
}
function drawTemplatePreview(ctx,drawFn,w,h){
  ctx.clearRect(0,0,w,h);
  ctx.save(); ctx.scale(w/200,h/200); drawFn(ctx); ctx.restore();
}
function loadTemplate(t){
  addLayer('Boceto - '+t.label);
  const ctx=getDrawCtx();
  ctx.save(); ctx.scale(S.canvasW/200,S.canvasH/200);
  ctx.strokeStyle='#555'; ctx.lineWidth=2; ctx.lineCap='round'; ctx.lineJoin='round';
  t.draw(ctx); ctx.restore();
  renderAll(); saveState(); updateLayersPanel();
}

// Template drawings (200x200 coordinate space)
function drawDino(ctx){
  ctx.beginPath();ctx.ellipse(110,120,50,35,0,0,Math.PI*2);ctx.stroke(); // body
  ctx.beginPath();ctx.ellipse(145,90,25,20,-0.3,0,Math.PI*2);ctx.stroke(); // head
  ctx.beginPath();ctx.moveTo(165,80);ctx.lineTo(175,65);ctx.lineTo(178,70);ctx.stroke(); // mouth
  ctx.beginPath();ctx.moveTo(90,145);ctx.lineTo(80,165);ctx.moveTo(105,150);ctx.lineTo(100,170);ctx.moveTo(120,150);ctx.lineTo(122,170);ctx.stroke(); // legs
  ctx.beginPath();ctx.moveTo(65,120);ctx.quadraticCurveTo(50,110,55,95);ctx.stroke(); // tail
  ctx.beginPath();ctx.moveTo(115,92);ctx.lineTo(120,75);ctx.lineTo(125,92);ctx.moveTo(128,88);ctx.lineTo(132,73);ctx.lineTo(136,88);ctx.stroke(); // spines
  ctx.beginPath();ctx.arc(152,83,3,0,Math.PI*2);ctx.fill(); // eye
}
function drawHouse(ctx){
  ctx.strokeRect(50,100,100,80); // walls
  ctx.beginPath();ctx.moveTo(40,100);ctx.lineTo(100,45);ctx.lineTo(160,100);ctx.closePath();ctx.stroke(); // roof
  ctx.strokeRect(85,140,30,40); // door
  ctx.strokeRect(60,110,25,25); // window L
  ctx.strokeRect(115,110,25,25); // window R
  ctx.beginPath();ctx.moveTo(60,110);ctx.lineTo(85,135);ctx.moveTo(85,110);ctx.lineTo(60,135);ctx.stroke(); // X window
  ctx.beginPath();ctx.moveTo(115,110);ctx.lineTo(140,135);ctx.moveTo(140,110);ctx.lineTo(115,135);ctx.stroke();
}
function drawFlower(ctx){
  ctx.beginPath();ctx.moveTo(100,130);ctx.lineTo(100,175);ctx.stroke(); // stem
  ctx.beginPath();ctx.moveTo(100,155);ctx.quadraticCurveTo(125,148,130,135);ctx.stroke(); // leaf
  for(let i=0;i<6;i++){const a=i*Math.PI/3;const ex=100+45*Math.cos(a),ey=100+45*Math.sin(a);ctx.beginPath();ctx.ellipse(ex+(100-ex)*0.3,ey+(100-ey)*0.3,18,12,a,0,Math.PI*2);ctx.stroke();}
  ctx.beginPath();ctx.arc(100,100,20,0,Math.PI*2);ctx.stroke();
}
function drawRocket(ctx){
  ctx.beginPath();ctx.moveTo(100,30);ctx.quadraticCurveTo(130,60,130,100);ctx.lineTo(70,100);ctx.quadraticCurveTo(70,60,100,30);ctx.closePath();ctx.stroke();
  ctx.beginPath();ctx.moveTo(70,100);ctx.lineTo(55,125);ctx.lineTo(70,120);ctx.stroke(); // fin L
  ctx.beginPath();ctx.moveTo(130,100);ctx.lineTo(145,125);ctx.lineTo(130,120);ctx.stroke(); // fin R
  ctx.beginPath();ctx.arc(100,80,12,0,Math.PI*2);ctx.stroke(); // window
  ctx.beginPath();ctx.moveTo(90,120);ctx.quadraticCurveTo(100,145,110,120);ctx.closePath();ctx.stroke(); // flame outline
}
function drawCat(ctx){
  ctx.beginPath();ctx.ellipse(100,120,40,35,0,0,Math.PI*2);ctx.stroke(); // body
  ctx.beginPath();ctx.arc(100,80,28,0,Math.PI*2);ctx.stroke(); // head
  ctx.beginPath();ctx.moveTo(76,62);ctx.lineTo(68,42);ctx.lineTo(88,58);ctx.closePath();ctx.stroke(); // ear L
  ctx.beginPath();ctx.moveTo(124,62);ctx.lineTo(132,42);ctx.lineTo(112,58);ctx.closePath();ctx.stroke(); // ear R
  ctx.beginPath();ctx.arc(88,78,4,0,Math.PI*2);ctx.arc(112,78,4,0,Math.PI*2);ctx.stroke(); // eyes
  ctx.beginPath();ctx.moveTo(80,88);ctx.lineTo(68,85);ctx.moveTo(80,90);ctx.lineTo(67,90);ctx.moveTo(80,92);ctx.lineTo(68,95);ctx.stroke(); // whiskers L
  ctx.beginPath();ctx.moveTo(120,88);ctx.lineTo(132,85);ctx.moveTo(120,90);ctx.lineTo(133,90);ctx.moveTo(120,92);ctx.lineTo(132,95);ctx.stroke(); // whiskers R
  ctx.beginPath();ctx.moveTo(130,120);ctx.quadraticCurveTo(155,115,150,130);ctx.quadraticCurveTo(145,145,130,135);ctx.stroke(); // tail
}
function drawStar(ctx){
  const pts=5,cx=100,cy=100,r1=65,r2=28;
  ctx.beginPath();
  for(let i=0;i<pts*2;i++){const a=i*Math.PI/pts-Math.PI/2;const r=i%2===0?r1:r2;ctx.lineTo(cx+r*Math.cos(a),cy+r*Math.sin(a));}
  ctx.closePath(); ctx.stroke();
}

// ================================================================
//  ANIMATION
// ================================================================
function buildFrameStrip(){
  const strip=document.getElementById('frameStrip');
  [...strip.querySelectorAll('.frame-thumb')].forEach(f=>f.remove());
  S.frames.forEach((F,i)=>{
    const th=document.createElement('div'); th.className='frame-thumb'+(i===S.currentFrame?' active':'');
    const c=document.createElement('canvas'); c.width=112; c.height=84;
    const tc=c.getContext('2d'); tc.fillStyle='white'; tc.fillRect(0,0,112,84);
    const comp=compositeLayersToCanvas(F.layers); tc.drawImage(comp,0,0,112,84);
    th.appendChild(c);
    const num=document.createElement('div'); num.className='frame-num'; num.textContent=i+1;
    th.appendChild(num);
    th.title='Frame '+(i+1);
    th.addEventListener('click',()=>switchFrame(i));
    strip.insertBefore(th,document.getElementById('addFrameBtn'));
  });
}
function updateFrameStrip(){ buildFrameStrip(); }
function addFrame(){
  bindCurrentFrame();
  const base=S.layers.map(cloneLayer);
  S.frames.push({name:'Frame '+(S.frames.length+1),layers:base});
  switchFrame(S.frames.length-1); saveState('frame-add');
}
function drawFrameToVisibleCanvas(frameIndex){
  const ctx=canvasEl.getContext('2d'); ctx.clearRect(0,0,S.canvasW,S.canvasH);
  const F=S.frames[frameIndex]; if(!F) return;
  ctx.drawImage(compositeLayersToCanvas(F.layers),0,0);
}
function playAnim(){
  if(S.animPlaying) return;
  bindCurrentFrame();
  S.animPlaying=true;
  document.getElementById('animPlayBtn').textContent='⏸ Pausa';
  let f=0;
  S.animTimer=setInterval(()=>{drawFrameToVisibleCanvas(f); f=(f+1)%Math.max(1,S.frames.length);},1000/S.animFPS);
}
function stopAnim(){
  S.animPlaying=false;
  clearInterval(S.animTimer);
  document.getElementById('animPlayBtn').textContent='▶ Play';
  renderAll();
}

// ================================================================
//  LAYERS PANEL
// ================================================================
function updateLayersPanel(){
  const list=document.getElementById('layersList'); list.textContent='';
  [...S.layers].reverse().forEach((L,ri)=>{
    const i=S.layers.length-1-ri;
    const item=document.createElement('div'); item.className='layer-item'+(i===S.activeLayer?' active':'');

    const thumb=document.createElement('div'); thumb.className='layer-thumb';
    const thumbCanvas=document.createElement('canvas'); thumbCanvas.id=`lth-${i}`; thumbCanvas.width=72; thumbCanvas.height=56;
    thumb.appendChild(thumbCanvas);

    const info=document.createElement('div'); info.className='layer-info';
    const name=document.createElement('div'); name.className='layer-name-el'; name.textContent=L.name||'Capa';
    const blend=document.createElement('div'); blend.className='layer-blend-el'; blend.textContent=L.blendMode==='source-over'?'Normal':L.blendMode;
    info.appendChild(name); info.appendChild(blend);

    const vis=document.createElement('div'); vis.className='layer-vis'+(L.visible?'':' hidden'); vis.dataset.i=i;
    const svgNS='http://www.w3.org/2000/svg';
    const svg=document.createElementNS(svgNS,'svg'); svg.setAttribute('viewBox','0 0 14 14'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','1.5');
    if(L.visible){
      const path=document.createElementNS(svgNS,'path'); path.setAttribute('d','M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z');
      const circle=document.createElementNS(svgNS,'circle'); circle.setAttribute('cx','7'); circle.setAttribute('cy','7'); circle.setAttribute('r','2');
      svg.appendChild(path); svg.appendChild(circle);
    }else{
      const p1=document.createElementNS(svgNS,'path'); p1.setAttribute('d','M1 1l12 12M5 4a4 4 0 0 1 5 5');
      const p2=document.createElementNS(svgNS,'path'); p2.setAttribute('d','M2 7a7 7 0 0 0 10 2');
      svg.appendChild(p1); svg.appendChild(p2);
    }
    vis.appendChild(svg);

    item.appendChild(thumb); item.appendChild(info); item.appendChild(vis);
    item.addEventListener('click',e=>{if(e.target.closest('.layer-vis'))return;S.activeLayer=i;updateLayersPanel();});
    vis.addEventListener('click',e=>{e.stopPropagation();captureLayerBefore('layer-visibility');L.visible=!L.visible;renderAll();saveState('layer-visibility');updateLayersPanel();});
    list.appendChild(item);
  });
  updateLayerThumbs();
}
function updateLayerThumbs(){
  S.layers.forEach((L,i)=>{
    const th=document.getElementById(`lth-${i}`); if(!th) return;
    const tc=th.getContext('2d'); tc.clearRect(0,0,72,56);
    for(let x=0;x<72;x+=5)for(let y=0;y<56;y+=5){tc.fillStyle=(Math.floor(x/5)+Math.floor(y/5))%2?'#ccc':'#eee';tc.fillRect(x,y,5,5);}
    tc.drawImage(L.canvas,0,0,72,56);
  });
}

// ================================================================
//  TOOL MANAGEMENT
// ================================================================
function setTool(id){
  S.tool=id;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b=>{
    const active=b.dataset.tool===id;
    b.classList.toggle('active',active);
    b.setAttribute('aria-pressed',String(active));
  });
  const names={draw:'Pincel',pencil:'Lápiz',spray:'Aerógrafo',chalk:'Tiza',watercolor:'Acuarela',line:'Línea',rect:'Rectángulo',ellipse:'Elipse',fill:'Relleno',text:'Texto',sticker:'Sticker',eyedropper:'Cuentagotas',eraser:'Borrador',smudge:'Difuminar'};
  document.getElementById('toolInfo').textContent=names[id]||id;
  // Auto brush type
  const toolBrushMap={pencil:'pencil',spray:'spray',chalk:'chalk',watercolor:'watercolor',draw:'round'};
  if(toolBrushMap[id]) S.brushType=toolBrushMap[id];
  buildBrushGrid();
}

// ================================================================
//  ZOOM
// ================================================================
document.getElementById('zoomInBtn').addEventListener('click',()=>{S.zoom=Math.min(12,S.zoom*1.2);applyZoom();});
document.getElementById('zoomOutBtn').addEventListener('click',()=>{S.zoom=Math.max(0.05,S.zoom/1.2);applyZoom();});
document.getElementById('zoomFitBtn').addEventListener('click',fitScreen);
canvasWrap.addEventListener('wheel',e=>{e.preventDefault();S.zoom=Math.max(0.05,Math.min(12,S.zoom*(e.deltaY>0?0.92:1.09)));applyZoom();},{passive:false});

// ================================================================
//  SYMMETRY
// ================================================================
document.getElementById('symCheck').addEventListener('change',e=>{
  S.symmetry=e.target.checked;
  document.getElementById('symLine').style.display=S.symmetry?'block':'none';
});

// ================================================================
//  TABS
// ================================================================
document.querySelectorAll('.rp-tab[data-tab]').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.rp-tab[data-tab]').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
    document.querySelectorAll('.rp-page[id^="tab-"]').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected','true');
    document.getElementById('tab-'+tab.dataset.tab).classList.add('active');
  });
});
document.querySelectorAll('.rp-tab[data-subtab]').forEach(tab=>{
  tab.addEventListener('click',()=>{
    const parent=tab.closest('.rp-page');
    parent.querySelectorAll('.rp-tab[data-subtab]').forEach(t=>{t.classList.remove('active');t.setAttribute('aria-selected','false');});
    parent.querySelectorAll('.rp-page[id^="subtab-"]').forEach(p=>p.classList.remove('active'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected','true');
    document.getElementById('subtab-'+tab.dataset.subtab).classList.add('active');
  });
});

// ================================================================
//  CANVAS EVENTS
// ================================================================
canvasEl.addEventListener('pointerdown',startDraw);
canvasEl.addEventListener('pointermove',moveDraw);
canvasEl.addEventListener('pointerup',endDraw);
canvasEl.addEventListener('pointercancel',endDraw);
canvasEl.addEventListener('pointerleave',()=>{if(!S.isDrawing)document.getElementById('cursorRing').style.display='none';});
canvasEl.addEventListener('contextmenu',e=>e.preventDefault());

// ================================================================
//  TOOLBAR WIRING
// ================================================================
document.querySelectorAll('.tool-btn[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
document.getElementById('undoTopBtn').addEventListener('click',undo);
document.getElementById('redoTopBtn').addEventListener('click',redo);

document.getElementById('addLayerBtn').addEventListener('click',()=>addLayer());
document.getElementById('dupLayerBtn').addEventListener('click',()=>{
  const L=S.layers[S.activeLayer];
  const nl={canvas:document.createElement('canvas'),name:L.name+' copia',visible:L.visible,opacity:L.opacity,blendMode:L.blendMode};
  nl.canvas.width=S.canvasW;nl.canvas.height=S.canvasH;
  nl.canvas.getContext('2d').drawImage(L.canvas,0,0);
  S.layers.splice(S.activeLayer,0,nl); saveState(); updateLayersPanel(); renderAll();
});
document.getElementById('mergeLayerBtn').addEventListener('click',()=>{
  if(S.layers.length<2||S.activeLayer===S.layers.length-1) return;
  const above=S.layers[S.activeLayer];
  const below=S.layers[S.activeLayer+1];
  const bc=below.canvas.getContext('2d');
  bc.drawImage(above.canvas,0,0);
  S.layers.splice(S.activeLayer,1);
  S.activeLayer=Math.min(S.activeLayer,S.layers.length-1);
  saveState(); updateLayersPanel(); renderAll();
});
document.getElementById('delLayerBtn').addEventListener('click',()=>{
  if(S.layers.length<=1) return;
  S.layers.splice(S.activeLayer,1);
  S.activeLayer=Math.min(S.activeLayer,S.layers.length-1);
  saveState(); updateLayersPanel(); renderAll();
});

document.getElementById('sizeSlider').addEventListener('input',e=>{S.brushSize=parseInt(e.target.value);document.getElementById('szLbl').textContent=e.target.value+'px';});
document.getElementById('opacSlider').addEventListener('input',e=>{S.opacity=parseInt(e.target.value)/100;document.getElementById('opLbl').textContent=e.target.value+'%';});
document.getElementById('flowSlider').addEventListener('input',e=>{S.flow=parseInt(e.target.value)/100;document.getElementById('flLbl').textContent=e.target.value+'%';});
document.getElementById('hardSlider').addEventListener('input',e=>{S.hardness=parseInt(e.target.value)/100;document.getElementById('hdLbl').textContent=e.target.value+'%';});

document.getElementById('brightSlider').addEventListener('input',e=>document.getElementById('brightLbl').textContent=e.target.value);
document.getElementById('contrastSlider').addEventListener('input',e=>document.getElementById('contrastLbl').textContent=e.target.value);
document.getElementById('satSlider').addEventListener('input',e=>document.getElementById('satLbl').textContent=e.target.value);
document.getElementById('blurSlider').addEventListener('input',e=>document.getElementById('blurLbl').textContent=e.target.value+'px');
document.getElementById('applyFilterBtn').addEventListener('click',applyAdjustments);

document.getElementById('stickerSzSlider').addEventListener('input',e=>{S.stickerSize=parseInt(e.target.value);document.getElementById('stickerSzLbl').textContent=e.target.value+'px';});

document.getElementById('animPlayBtn').addEventListener('click',()=>{if(S.animPlaying)stopAnim();else playAnim();});
document.getElementById('animStopBtn').addEventListener('click',stopAnim);
document.getElementById('fpsSlider').addEventListener('input',e=>{S.animFPS=parseInt(e.target.value);document.getElementById('fpsLbl').textContent=e.target.value;});
document.getElementById('addFrameBtn').addEventListener('click',addFrame);
const onionBtn=document.getElementById('onionToggle');
onionBtn.addEventListener('click',()=>{S.onionSkin=!S.onionSkin;onionBtn.classList.toggle('on',S.onionSkin);renderAll();});

// New canvas modal
document.getElementById('newCanvasBtn').addEventListener('click',()=>openModal('newModal'));
document.getElementById('cancelNewBtn').addEventListener('click',()=>closeModal('newModal'));
document.getElementById('confirmNewBtn').addEventListener('click',()=>{
  const w=parseInt(document.getElementById('newW').value)||800;
  const h=parseInt(document.getElementById('newH').value)||600;
  S.canvasName=document.getElementById('newName').value||'Sin título';
  document.getElementById('canvasName').textContent=S.canvasName;
  closeModal('newModal');
  initCanvas(w,h);
});
document.querySelectorAll('.preset-btn[data-w]').forEach(b=>{
  b.addEventListener('click',()=>{document.getElementById('newW').value=b.dataset.w;document.getElementById('newH').value=b.dataset.h;});
});

// Export
document.getElementById('exportBtn').addEventListener('click',()=>openModal('exportModal'));
document.getElementById('cancelExpBtn').addEventListener('click',()=>closeModal('exportModal'));
document.getElementById('savePngBtn').addEventListener('click',async()=>{await saveProjectToDB(S.projectId&&S.projectId!==AUTOSAVE_KEY?S.projectId:'project-'+Date.now()); await refreshGallery(); exportAs('png');});
document.getElementById('expPng').addEventListener('click',()=>{exportAs('png');closeModal('exportModal');});
document.getElementById('expJpg').addEventListener('click',()=>{exportAs('jpg');closeModal('exportModal');});
document.getElementById('expWebp').addEventListener('click',()=>{exportAs('webp');closeModal('exportModal');});
document.getElementById('expGif').addEventListener('click',()=>{exportAnimatedGif();closeModal('exportModal');});
document.getElementById('expJson').addEventListener('click',()=>{exportProject();closeModal('exportModal');});

function exportAs(fmt){
  bindCurrentFrame();
  const out=compositeLayersToCanvas(S.layers);
  const ctx=out.getContext('2d');
  if(fmt==='jpg'){
    const flat=document.createElement('canvas'); flat.width=S.canvasW; flat.height=S.canvasH;
    const fc=flat.getContext('2d'); fc.fillStyle='#fff'; fc.fillRect(0,0,flat.width,flat.height); fc.drawImage(out,0,0);
    downloadDataUrl(flat.toDataURL('image/jpeg',0.92),`${safeName(S.canvasName)}.jpg`); return;
  }
  const mime=fmt==='webp'?'image/webp':'image/png';
  downloadDataUrl(out.toDataURL(mime,0.92),`${safeName(S.canvasName)}.${fmt==='webp'?'webp':'png'}`);
}
function safeName(n){return (n||'Sin titulo').replace(/[\\/:*?"<>|]/g,'_').slice(0,60);}
function downloadDataUrl(url,filename){const a=document.createElement('a'); a.download=filename; a.href=url; a.click();}
function exportProject(){
  const data=snapshotProject();
  data.version=3; data.profile=S.profile; data.savedAt=new Date().toISOString(); data.id=S.projectId||('project-'+Date.now());
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  const a=document.createElement('a'); a.download=safeName(S.canvasName)+'.estudio.json'; a.href=URL.createObjectURL(blob); a.click();
}
async function exportAnimatedGif(){
  await exportAnimationVideo();
}
async function exportAnimationVideo(){
  bindCurrentFrame();
  const fps=S.animFPS||6;
  const out=document.createElement('canvas'); out.width=S.canvasW; out.height=S.canvasH;
  const ctx=out.getContext('2d');
  if(!out.captureStream || typeof MediaRecorder==='undefined'){
    alert('Este navegador no soporta exportación de video. Exporta el proyecto .json o PNG desde el menú.');
    return;
  }
  const stream=out.captureStream(fps);
  const chunks=[];
  const mime=MediaRecorder.isTypeSupported('video/webm;codecs=vp9')?'video/webm;codecs=vp9':'video/webm';
  const rec=new MediaRecorder(stream,{mimeType:mime});
  rec.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data);};
  rec.onstop=()=>{const blob=new Blob(chunks,{type:'video/webm'});const a=document.createElement('a');a.download=safeName(S.canvasName)+'.webm';a.href=URL.createObjectURL(blob);a.click();};
  rec.start();
  const delay=1000/fps;
  const frames=Math.max(1,S.frames.length);
  for(let loops=0; loops<2; loops++){
    for(let i=0;i<frames;i++){
      ctx.clearRect(0,0,S.canvasW,S.canvasH);
      ctx.drawImage(compositeLayersToCanvas(S.frames[i].layers),0,0);
      await new Promise(r=>setTimeout(r,delay));
    }
  }
  rec.stop();
}

async function importProjectJson(text){
  const d=JSON.parse(text);
  if(!d.layers && !d.frames) throw new Error('El archivo no parece ser un proyecto de Estudio Arte.');
  await applyProjectData(d,{preserveId:false});
  await saveProjectToDB(); await refreshGallery(); hideStartScreen();
}
async function importAnyFile(file){
  if(!file) return;
  if(file.name.toLowerCase().endsWith('.json') || file.type.includes('json')){
    const text=await file.text(); await importProjectJson(text); return;
  }
  if(file.type.startsWith('image/')){
    const url=await new Promise(res=>{const reader=new FileReader();reader.onload=e=>res(e.target.result);reader.readAsDataURL(file);});
    const img=await loadImage(url);
    const sc=Math.min(S.canvasW/img.width,S.canvasH/img.height,1);
    const w=img.width*sc,h=img.height*sc;
    getDrawCtx().drawImage(img,(S.canvasW-w)/2,(S.canvasH-h)/2,w,h);
    renderAll(); saveState('import-image'); hideStartScreen(); return;
  }
  alert('Formato no soportado. Usa imagen o .estudio.json');
}
// Import
const importInput=document.getElementById('importInput');
document.getElementById('importBtn').addEventListener('click',()=>importInput.click());
importInput.addEventListener('change',async e=>{await importAnyFile(e.target.files[0]); e.target.value='';});

document.getElementById('importTemplateBtn').addEventListener('click',()=>document.getElementById('importTemplateInput').click());
document.getElementById('importTemplateInput').addEventListener('change',async e=>{
  const file=e.target.files[0]; if(!file) return;
  const url=await new Promise(res=>{const reader=new FileReader();reader.onload=ev=>res(ev.target.result);reader.readAsDataURL(file);});
  const img=await loadImage(url);
  addLayer('Imagen importada');
  const ctx=getDrawCtx();
  const sc=Math.min(S.canvasW/img.width,S.canvasH/img.height,1);
  const w=img.width*sc,h=img.height*sc;
  ctx.drawImage(img,(S.canvasW-w)/2,(S.canvasH-h)/2,w,h);
  ctx.globalCompositeOperation='source-atop'; ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.fillRect(0,0,S.canvasW,S.canvasH); ctx.globalCompositeOperation='source-over';
  addLayer('Mi dibujo'); renderAll(); saveState('template-image'); updateLayersPanel(); e.target.value='';
});

// ================================================================
//  KEYBOARD
// ================================================================
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();undo();}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='z'))){e.preventDefault();redo();}
  if(e.key==='b'||e.key==='B') setTool('draw');
  if(e.key==='e'||e.key==='E') setTool('eraser');
  if(e.key==='g'||e.key==='G') setTool('fill');
  if(e.key==='i'||e.key==='I') setTool('eyedropper');
  if(e.key==='l'||e.key==='L') setTool('line');
  if(e.key==='r'||e.key==='R') setTool('rect');
  if(e.key==='t'||e.key==='T') setTool('text');
  if(e.key==='['){ S.brushSize=Math.max(1,S.brushSize-3);document.getElementById('sizeSlider').value=S.brushSize;document.getElementById('szLbl').textContent=S.brushSize+'px';}
  if(e.key===']'){ S.brushSize=Math.min(120,S.brushSize+3);document.getElementById('sizeSlider').value=S.brushSize;document.getElementById('szLbl').textContent=S.brushSize+'px';}
});

// ================================================================
//  AUTOSAVE + GALLERY with IndexedDB
// ================================================================
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('projects'))db.createObjectStore('projects',{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function putProject(record){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(record);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});}
async function getProject(id){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction('projects','readonly');const q=tx.objectStore('projects').get(id);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error);});}
async function getAllProjects(){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction('projects','readonly');const q=tx.objectStore('projects').getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error);});}
async function deleteProjectDB(id){const db=await openDB();return new Promise((res,rej)=>{const tx=db.transaction('projects','readwrite');tx.objectStore('projects').delete(id);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);});}
function makeThumb(){const out=compositeLayersToCanvas(S.layers);const th=document.createElement('canvas');th.width=320;th.height=240;const c=th.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,320,240);const sc=Math.min(320/S.canvasW,240/S.canvasH);const w=S.canvasW*sc,h=S.canvasH*sc;c.drawImage(out,(320-w)/2,(240-h)/2,w,h);return th.toDataURL('image/jpeg',0.82);}
async function saveProjectToDB(id=S.projectId||AUTOSAVE_KEY){
  bindCurrentFrame();
  const data=await snapshotProjectForDB(); data.version=4; data.profile=S.profile; data.id=id; data.savedAt=new Date().toISOString();
  const record={id,name:S.canvasName||'Sin título',updatedAt:Date.now(),thumb:makeThumb(),data};
  await putProject(record); S.projectId=id; S.dirty=false;
}
let autosaveTimer=null;
function scheduleAutosave(){clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>saveProjectToDB().then(refreshGallery).catch(()=>{}),1200);}
async function loadAutosave(){
  const rec=await getProject(AUTOSAVE_KEY);
  if(!rec) return false;
  await applyProjectData(rec.data,{preserveId:true,skipHistory:true});
  S.projectId=AUTOSAVE_KEY; S.history=[]; S.historyIndex=-1; saveState('autosave-load');
  return true;
}
async function refreshGallery(){
  const grid=document.getElementById('projectsGrid'); if(!grid) return;
  const items=(await getAllProjects()).filter(x=>x.id!==AUTOSAVE_KEY).sort((a,b)=>b.updatedAt-a.updatedAt);
  grid.textContent='';
  if(!items.length){
    const empty=document.createElement('div'); empty.className='empty-gallery'; empty.textContent='Aún no hay dibujos guardados en esta tablet.';
    grid.appendChild(empty); return;
  }
  items.forEach(rec=>{
    const card=document.createElement('div'); card.className='project-card';
    const img=document.createElement('img'); img.alt='Miniatura del dibujo'; img.src=rec.thumb||'';
    const title=document.createElement('strong'); title.textContent=rec.name||'Sin título';
    const date=document.createElement('small'); date.textContent=new Date(rec.updatedAt).toLocaleDateString();
    const actions=document.createElement('div'); actions.className='gallery-card-actions';
    const openBtn=document.createElement('button'); openBtn.className='gallery-mini-btn'; openBtn.type='button'; openBtn.textContent='Abrir';
    const renameBtn=document.createElement('button'); renameBtn.className='gallery-mini-btn'; renameBtn.type='button'; renameBtn.textContent='Renombrar';
    const dupBtn=document.createElement('button'); dupBtn.className='gallery-mini-btn'; dupBtn.type='button'; dupBtn.textContent='Duplicar';
    const delBtn=document.createElement('button'); delBtn.className='gallery-mini-btn danger'; delBtn.type='button'; delBtn.textContent='Borrar';
    actions.append(openBtn,renameBtn,dupBtn,delBtn);
    card.append(img,title,date,actions);
    const open=async()=>{await applyProjectData(rec.data,{preserveId:false});S.projectId=rec.id;hideStartScreen();};
    img.addEventListener('click',open); title.addEventListener('click',open); openBtn.addEventListener('click',open);
    renameBtn.addEventListener('click',async e=>{e.stopPropagation();const nn=prompt('Nuevo nombre del dibujo:',rec.name||'Sin título');if(!nn)return;rec.name=nn.trim().slice(0,60)||'Sin título';rec.data.name=rec.name;rec.updatedAt=Date.now();await putProject(rec);await refreshGallery();});
    dupBtn.addEventListener('click',async e=>{e.stopPropagation();const copy=cloneProjectData(rec);copy.id='project-'+Date.now();copy.name=(rec.name||'Dibujo')+' copia';copy.updatedAt=Date.now();copy.data.id=copy.id;copy.data.name=copy.name;await putProject(copy);await refreshGallery();});
    delBtn.addEventListener('click',async e=>{e.stopPropagation();const code=prompt('Para borrar este dibujo escribe BORRAR.');if(code!=='BORRAR')return;await deleteProjectDB(rec.id);if(S.projectId===rec.id)S.projectId=null;await refreshGallery();});
    grid.appendChild(card);
  });
}
function applyProfileMode(){
  const age=parseInt(document.getElementById('profileAge')?.value||'')||null;
  const mode=document.getElementById('profileMode')?.value||'auto';
  const name=(document.getElementById('profileName')?.value||'').trim().slice(0,28);
  S.profile={name,age,mode};
  let effective=mode;
  if(mode==='auto') effective=age ? (age<8?'kids':age<13?'explore':'studio') : 'studio';
  S.profileMode=effective;
  document.body.classList.remove('mode-kids','mode-explore','mode-studio');
  document.body.classList.add('mode-'+effective);
  document.body.setAttribute('data-profile-mode',effective);
  document.body.setAttribute('data-theme',effective==='kids'?'kids':S.theme);
  if(effective==='kids'){
    S.brushSize=Math.max(S.brushSize,28);
    document.getElementById('sizeSlider').value=S.brushSize;
    document.getElementById('szLbl').textContent=S.brushSize+'px';
    setTool('draw');
  }else if(effective==='explore'){
    S.brushSize=Math.max(S.brushSize,20);
    document.getElementById('sizeSlider').value=S.brushSize;
    document.getElementById('szLbl').textContent=S.brushSize+'px';
  }
  const colorTab=document.querySelector('.rp-tab[data-tab="color"]');
  if(colorTab && (effective==='kids'||effective==='explore')) colorTab.click();
}
function hideStartScreen(){
  const start=document.getElementById('startScreen');
  start?.classList.add('hidden');
  start?.setAttribute('aria-hidden','true');
}
function showStartScreen(){
  const start=document.getElementById('startScreen');
  start?.classList.remove('hidden');
  start?.setAttribute('aria-hidden','false');
  refreshGallery();
}

// ================================================================
//  INIT
// ================================================================
window.addEventListener('load',async()=>{
  initCanvas(800,600);
  setupColorPicker();
  buildPalette();
  buildBrushGrid();
  buildFilterGrid();
  buildTemplates();
  buildStickerPicker();
  buildFrameStrip();
  updateColorUI();
  updateThemeButtons();
  setTool(S.tool);
  await refreshGallery();
  document.getElementById('startNewBtn').addEventListener('click',()=>{applyProfileMode();S.projectId='project-'+Date.now();S.canvasName=(S.profile.name?`Dibujo de ${S.profile.name}`:'Sin título');document.getElementById('canvasName').textContent=S.canvasName;initCanvas(800,600);hideStartScreen();});
  document.getElementById('startOpenBtn').addEventListener('click',()=>importInput.click());
  document.getElementById('startContinueBtn').addEventListener('click',async()=>{applyProfileMode();const ok=await loadAutosave();if(!ok)initCanvas(800,600);hideStartScreen();});
  document.getElementById('startThemeToggle').addEventListener('click',()=>document.getElementById('themeToggle').click());
  document.querySelector('.app-title').addEventListener('dblclick',showStartScreen);
  const drawerBtn=document.getElementById('panelDrawerBtn');
  const drawerHandle=document.getElementById('drawerHandle');
  const toggleDrawer=()=>document.body.classList.toggle('panel-open');
  drawerBtn?.addEventListener('click',toggleDrawer);
  drawerHandle?.addEventListener('click',toggleDrawer);
  registerServiceWorker();
  setTimeout(()=>{drawHSV();drawHue();drawOpacity();fitScreen();},120);
});
window.addEventListener('resize',()=>{drawHSV();drawHue();drawOpacity();});
