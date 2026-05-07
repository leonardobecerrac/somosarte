export function cloneProjectData(data){
  if(!data) return null;
  if(typeof structuredClone==='function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
}

export function canvasToBlob(canvas,type='image/png',quality=0.92){
  return new Promise(resolve=>{
    if(canvas.toBlob) canvas.toBlob(blob=>resolve(blob),type,quality);
    else resolve(dataUrlToBlob(canvas.toDataURL(type,quality)));
  });
}

function dataUrlToBlob(url){
  const [meta,body]=url.split(',');
  const mime=(meta.match(/data:(.*?);/)||[])[1]||'application/octet-stream';
  const bytes=atob(body);
  const arr=new Uint8Array(bytes.length);
  for(let i=0;i<bytes.length;i++) arr[i]=bytes.charCodeAt(i);
  return new Blob([arr],{type:mime});
}
