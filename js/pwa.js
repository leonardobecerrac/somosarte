export function registerServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  if(location.protocol === 'file:') return;
  navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
}
