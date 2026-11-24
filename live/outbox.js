// One local record per operation, isolated by shift and membership. Server receipts
// cover the interval between committing an operation and receiving its response.
export function createOutbox(user, send, report){
 const prefix=['perron-action',user.shiftId,user.obj,user.membershipId||user.id,''].join('/');
 let draining=null,sequence=0;
 function entries(){
  return Object.keys(localStorage).filter(k=>k.startsWith(prefix)&&!k.endsWith('!error')).map(k=>JSON.parse(localStorage.getItem(k))).filter(Boolean)
   .sort((a,b)=>a.at-b.at||a.sequence-b.sequence);
 }
 async function deliver(){
  let delivered=0;
  for(const item of entries()){
   try{
    await send(item.endpoint,item.body);
   }catch(error){
    if(!error.status||error.status>=500||error.status===401){
     report('Сохранено на устройстве. Ожидает отправки: '+entries().length);return;
    }
    // Keep a visible record of a business conflict, e.g. an expired offer.
    localStorage.setItem(prefix+'!error',JSON.stringify({message:error.message}));
    localStorage.removeItem(prefix+item.body.requestId);
    continue;
   }
   localStorage.removeItem(prefix+item.body.requestId);delivered++;
  }
  const conflict=localStorage.getItem(prefix+'!error');
  if(conflict)report('Сервер отклонил действие: '+JSON.parse(conflict).message);
  else if(delivered)report('Действия доставлены');
 }
 function flush(){
  if(!draining)draining=deliver().finally(()=>{draining=null});
  return draining;
 }
 async function submit(endpoint,data){
  const requestId=crypto.randomUUID(),body={...data,requestId,shiftId:user.shiftId};
  const at=Date.now();
  localStorage.setItem(prefix+requestId,JSON.stringify({at,sequence:sequence++,endpoint,body}));
  report('Действие сохранено на устройстве');
  if(draining)await draining;
  await flush();
 }
 return {submit,flush};
}
