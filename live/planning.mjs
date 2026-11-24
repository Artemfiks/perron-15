import {network,xy,center} from './route.js';
import config from './site.json' with {type:'json'};
import {forbiddenObjects} from './access.mjs';
import {insideZone} from './lifecycle.mjs';
export function planner(roads,zones,objects,agents,points,jobs){
 let closed=[],walk,drive;
 const barriers=forbiddenObjects(objects,config.blockedObjects);
 function close(ids){closed=[...new Set(ids)];walk=network(roads,'walk',closed,barriers);drive=network(roads,'drive',closed,barriers)}
 close([]);
 const destinations=new Map(zones.map(z=>[z.properties.id,center(z)]));
 const stores=objects.filter(f=>config.stores.includes(f.properties.id)).map(center);
 const fresh=p=>p&&Date.now()-p.time<=60000&&p.accuracy<=50;
 function destination(c){
  const tail=c.tail?.trim().toUpperCase();
  const plane=tail&&agents.find(a=>a.kind==='aircraft'&&[a.id,a.obj].some(v=>v?.toUpperCase()===tail));
  const fix=plane&&points.get(plane.id);
  if(!fresh(fix))return {target:destinations.get(c.zone),zone:c.zone,source:'Зона '+c.zone};
  const coords=[fix.lon,fix.lat];
  return {target:xy(coords),zone:zones.find(z=>insideZone(coords,z))?.properties.id??null,source:'GPS борта '+plane.id};
 }
 function join(start,via,target,route){const out={path:[start],minutes:0,meters:0};for(const end of [...via,target]){
  const leg=route(out.path.at(-1),end);if(!leg)return null;
  out.path.push(...leg.path.slice(1));out.minutes+=leg.minutes;out.meters+=leg.meters;
 }return out}
 function plan(id,c,reservedVehicle){
  const p=points.get(id),{target}=destination(c);
  if(!fresh(p)||!target)return null;
  const start=xy([p.lon,p.lat]);
  const variants=[];
  const drop=drive.dropoff(target);
  const finish=drop&&(walk.clearConnector(drop,target)?
   {path:[drop,target],meters:Math.hypot(drop[0]-target[0],drop[1]-target[1]),minutes:Math.hypot(drop[0]-target[0],drop[1]-target[1])/(5000/60)}:walk(drop,target));
  const kits=c.kit&&!c.kitCollected?stores.map(s=>[s]):[[]];
  for(const via of kits){
   const direct=join(start,via,target,walk);
   if(direct&&(!c.boarded||c.disembarked))variants.push({...direct,mode:'Пешком',minutes:direct.minutes+via.length*.5,store:via[0]});
   for(const a of agents.filter(a=>a.kind==='vehicle')){
    if(c.disembarked||a.id===reservedVehicle)continue;
    if(jobs.get(id)===c&&c.vehicle!==a.id)continue;
    const vp=points.get(a.id);if((!c.boarded&&!fresh(vp))||[...jobs].some(([owner,j])=>owner!==id&&j.vehicle===a.id))continue;
    if(!finish)continue;
    const car=c.boarded?start:xy([vp.lon,vp.lat]),approach=c.boarded?{path:[start],meters:0,minutes:0}:walk(start,car),leg=join(car,via,drop,drive);
    if(!approach||!leg)continue;
    variants.push({mode:a.id,vehicle:a.id,store:via[0],pickup:car,dropoff:drop,minutes:approach.minutes+leg.minutes+finish.minutes+(c.boarded?10:20)/60+via.length*.5,
       meters:approach.meters+leg.meters+finish.meters,path:[...approach.path,...leg.path.slice(1),...finish.path.slice(1)]});
   }
  }
  variants.sort((a,b)=>a.minutes-b.minutes);
  const best=variants[0];
  if(!best)return null;
  best.alternatives=Object.values(Object.fromEntries([...variants].reverse().map(v=>[v.mode,{mode:v.mode,minutes:v.minutes,meters:v.meters}])));
  return best;
 }
 function unavailable(id,c){
  const p=points.get(id),{target}=destination(c);
  if(!p||!target)return 'Недостаточно данных для маршрута';
  const coords=[p.lon,p.lat],start=xy(coords);
  const obstacle=barriers.find(f=>insideZone(coords,f));
  if(obstacle)return 'GPS внутри закрытого контура «'+obstacle.properties.name+'». Нужна свежая точка на разрешённой дорожке за контуром.';
  if(!walk.canJoin(start))return 'От GPS-точки нет разрешённого подхода к открытой дороге в пределах 50 м.';
  if(!walk.canJoin(target))return destination(c).source+' · нет подхода по открытым дорогам.';
  if(c.kit&&!c.kitCollected&&walk(start,target))return 'До зоны можно дойти, но нет доступного маршрута через склад.';
  return 'Старт и зона '+c.zone+' не соединены доступными дорогами. Проверьте перекрытия.';
 }
 return {plan,unavailable,destination,close,get closed(){return closed}};
}
