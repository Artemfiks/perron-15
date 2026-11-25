import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {officialLineup,seedPositions} from '../lineup.mjs';
import {track} from '../track.mjs';
import {planner} from '../planning.mjs';
import {setOrigin,xy} from '../route.js';
import {insideZone} from '../lifecycle.mjs';

const layer = name => JSON.parse(readFileSync(new URL('../data/'+name+'.geojson',import.meta.url)));
const agents=officialLineup(), zones=layer('service_zones').features;
const planes=agents.filter(a=>a.kind==='aircraft'), engineers=agents.filter(a=>a.kind==='engineer');
const expectedZones=[9,10,5,6,7,1,2,3,4,8];
setOrigin(layer('airport_boundaries'));
function fixture(){
 const roster=structuredClone(agents),points=new Map(),jobs=new Map();
 seedPositions(roster,points);
 return {roster,points,jobs,routing:planner(layer('roads'),zones,layer('objects').features,roster,points,jobs)};
}
test('Официальные точки, 10 стоянок, 70 пар и соседние полигоны',()=>{
 const {routing}=fixture();
 assert.equal(planes.length,10); assert.equal(engineers.length,7); assert.equal(agents.length,20);
 assert.equal(zones.length,10);
 for(const [i,plane] of planes.entries()){
  const matching=zones.filter(z=>insideZone(plane.initial,z));
  assert.equal(matching.length,1);
  const zone=matching[0].properties.id;
  assert.equal(zone,expectedZones[i]);
  assert.equal(matching[0].properties.name,'мс-'+String(zone).padStart(2,'0'));
  const c={tail:plane.obj,zone:zone%10+1,forceVehicle:true,kit:true};
  assert.equal(routing.destination(c).zone,zone);
  for(const engineer of engineers){
   const r=routing.plan(engineer.id,c);
   if(engineer.obj==='AT-0001'){assert.equal(r,null);continue}
   assert(r?.vehicle&&r.store&&r.pickup&&r.dropoff);
   assert.deepEqual(r.path.at(-1),xy(plane.initial));
  }
  for(const other of planes.filter(p=>p!==plane))assert.equal(insideZone(other.initial,matching[0]),false);
 }
});
test('Живой AT-0001 сохраняет GPS при постоянной отправке и повторной расстановке',()=>{
 const {roster,points}=fixture(),obj='AT-0001',actual={obj,lon:37.635,lat:55.834};
 assert.equal(track(actual,roster,points,undefined,1000,'phone').applied,true);
 const [lon,lat]=roster.find(a=>a.id===obj).initial;
 const feed=track({points:[{obj,lon,lat},{obj:'AT-0002',lon,lat}]},roster,points,undefined,2000);
 assert.deepEqual(feed.map(x=>x.applied),[false,true]);assert.equal(seedPositions(roster,points),0);
 assert.equal(points.size,20);assert.equal(points.get(obj).lon,actual.lon);
});
test('Участие vehicle-03, причина недоступности и возврат пешего варианта',()=>{
 const {roster,points,routing}=fixture(),id='AT-0006',obj='vehicle-03';
 const c={tail:'RA-73106',zone:1,forceVehicle:true};
 roster.filter(a=>a.kind==='vehicle'&&a.obj!==obj).forEach(a=>{a.enabled=false});
 assert.equal(routing.plan(id,c),null);assert.match(routing.unavailable(id,c),/Нет доступного транспорта/);
 const optional=roster.find(a=>a.obj===obj),[lon,lat]=optional.initial;
 assert.equal(track({obj,lon,lat},roster,points).applied,false);
 optional.enabled=true;assert.equal(track({obj,lon,lat},roster,points).applied,true);
 assert.equal(routing.plan(id,c).vehicle,obj);
 optional.enabled=false;assert.equal(routing.plan(id,c),null);
 c.forceVehicle=false;assert.equal(routing.plan(id,c).mode,'Пешком');
});

test('Конкурсная смена через HTTP: телефон, стоянки, таймер, состав и перезапуск',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'perron-official-'));
 const env={...process.env,SHIFT_PROFILE:'official',HOST:'127.0.0.1',PORT:'0',STATE_DB:join(dir,'shift.db'),RENDER:'test',DISPATCH_CODE:'dispatch',ENGINEER_ONE_CODE:'phone',ENGINEER_TWO_CODE:'second'};
 let proc,base,d,e;
 async function start(){
  proc=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env,stdio:['ignore','pipe','inherit']});
  const [line]=await once(proc.stdout,'data');base=String(line).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
 }
 async function stop(){if(proc){const done=once(proc,'exit');proc.kill();await done;proc=null}}
 async function api(path,cookie,body,status=200){
  const r=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{cookie:cookie||'','Content-Type':'application/json',Origin:'https://itsim.geolaba.net'},body:body?JSON.stringify(body):undefined});
  assert.equal(r.status,status,path);
  if(path==='v1/track')assert.equal(r.headers.get('access-control-allow-origin'),'https://itsim.geolaba.net');
  if(path==='login')return r.headers.get('set-cookie').split(';')[0];
  return path==='log.csv'?r.text():r.json();
 }
 const login=(role,code)=>api('login','',{role,code});
 const gps=(obj,coords)=>({obj,lon:coords[0],lat:coords[1],acc:4});
 try{
  await start();d=await login('dispatcher','dispatch');e=await login('engineer','phone');
  assert.equal((await api('me',e)).obj,'AT-0001');
  const all=await api('agents',d);assert.equal(all.length,20);assert(all.every(a=>a.point.source==='start'));
  const fix=gps('AT-0001',engineers[1].initial);
  const sample=gps('vehicle-01',all.find(a=>a.obj==='vehicle-01').initial);
  const otherSource=await fetch(base+'/api/v1/track',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sample)});
  assert.equal(otherSource.status,401);
  assert.equal((await api('v1/track','',sample)).applied,true);
  await api('v1/track',e,fix);
  assert.equal((await api('v1/track','',gps('AT-0001',engineers[0].initial))).applied,false);
  await api('vehicle-participation',d,{enabled:true});
  assert.equal((await api('v1/track','',gps('vehicle-03',all.find(a=>a.obj==='vehicle-03').initial))).applied,true);
  await api('vehicle-participation',d,{enabled:false});
  assert.equal((await api('seed',d,{})).added,0);
  const second=await login('engineer','second');await api('logout',second,{});
  assert.equal((await api('agents',d)).find(a=>a.obj==='AT-0002').point.source,'start');
  const c=await api('calls',d,{tail:planes[0].obj,zone:10,aircraft:'A320',priority:'A',defect:'HYD',manualFirst:true});
  await api('assign',d,{number:c.number,engineer:'AT-0001'});await api('action',e,{number:c.number,action:'accept'});
  await api('trial',d,{number:c.number,forceVehicle:true});assert((await api('job',e)).route.vehicle);
  await api('trial',d,{number:c.number,forceVehicle:false});assert.equal((await api('job',e)).route.mode,'Пешком');
  await api('trial',d,{number:c.number,remainingSeconds:2});
  await api('v1/track',e,gps('AT-0001',planes[1].initial));assert.equal((await api('job',e)).status,'enroute');
  await sleep(3200);assert((await api('dispatch',d))[0].breachAt);
  await api('v1/track',e,gps('AT-0001',planes[0].initial));assert.equal((await api('job',e)).status,'arrived');
  const csv=await api('log.csv',d),timeChange=csv.lastIndexOf('"test-deadline"'),warning=csv.indexOf('"forecast-risk"',timeChange);
  assert(warning>timeChange&&csv.indexOf('"deadline-breach"',warning)>warning);
  assert(csv.includes('""standardInLimit"":true'));
  await api('point',e,{stop:true});await api('seed',d,{});
  await stop();await start();d=await login('dispatcher','dispatch');
  const restored=await api('agents',d),phone=restored.find(a=>a.obj==='AT-0001');
  assert.equal(phone.point.lon,planes[0].initial[0]);assert.equal(phone.point.stopped,true);
  assert.equal(restored.find(a=>a.obj==='vehicle-03').enabled,false);assert.equal(restored.length,20);
 }finally{await stop();rmSync(dir,{recursive:true,force:true})}
});
