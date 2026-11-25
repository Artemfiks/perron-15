export function track(body, agents, points, onApply=()=>{}, now=Date.now(),source='feed'){
 const batch=Object.hasOwn(body,'points');
 const input=batch?body.points:[body];
 const bad=()=>{throw Object.assign(Error('Некорректные координаты или поля точки'),{status:400})};
 if(!Array.isArray(input)||input.length>1000)bad();
 const rows=input.map(p=>{
  if(!p||typeof p.obj!=='string'||!Number.isFinite(p.lat)||!Number.isFinite(p.lon)||Math.abs(p.lat)>90||Math.abs(p.lon)>180)bad();
  if(p.t!==undefined&&(typeof p.t!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(p.t)))bad();
  const time=p.t===undefined?now:Date.parse(p.t);
  if(!Number.isFinite(time)||[p.acc,p.spd].some(v=>v!==undefined&&(!Number.isFinite(v)||v<0)))bad();
  return {obj:p.obj,lat:p.lat,lon:p.lon,accuracy:p.acc??0,time,speed:p.spd??null};
 });
 const result=rows.map(p=>{
  const a=agents.find(x=>x.obj===p.obj);
  const allowed=a&&!(a.obj==='AT-0001'&&a.initial&&source!=='phone')&&a.enabled!==false;
  const applied=!!allowed&&p.accuracy<=100&&p.time<=now+5000&&p.time>(points.get(a.id)?.time??0);
  if(applied){p.source=source;points.set(a.id,p);onApply(a,p)}
  return {accepted:true,applied,obj:p.obj,t:new Date(p.time).toISOString()};
 });
 return batch?result:result[0];
}
