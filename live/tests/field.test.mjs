import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {network,xy,setOrigin} from '../route.js';
import {transition} from '../lifecycle.mjs';
import {planner} from '../planning.mjs';
const geo=name=>JSON.parse(readFileSync(new URL('../data/'+name+'.geojson',import.meta.url)));
const pt=(x,y)=>[x/111320,-y/111320];
setOrigin({features:[{geometry:{coordinates:[[[[0,0]]]]}}]});
const edge=(id,type,speed,coords)=>({properties:{id,type,spd_kmh:speed},geometry:{coordinates:coords.map(([x,y])=>pt(x,y))}});
test('Точка вне графа, параллельная закрытая дорога, запрет и обход',()=>{
 const data={features:[edge(1,'service',10,[[0,0],[100,0]]),edge(2,'pedestrian',5,[[0,10],[100,10]]),edge(3,'taxi',10,[[0,8],[100,8]])]};
 const start=[10,9],end=[90,9];
 assert.equal(network(data,'drive')(start,end).path[1][1],0);
 assert.equal(network(data,'walk',[2])(start,end).path[1][1],0);
 assert.equal(network(data,'drive',[1])(start,end),null);
 const detour={features:[edge(4,'service',8,[[0,0],[100,0]]),edge(5,'service',10,[[0,0],[0,60],[100,60],[100,0]])]};
 assert(network(detour,'drive',[4])([0,0],[100,0]).meters>2*network(detour,'drive')([0,0],[100,0]).meters);
});
test('Контроль 374 с по рёбрам, 494 с от регистрации, 15:00 и 15:01',()=>{
 const roads={features:[edge(1,'pedestrian',5,[[0,0],[200,0]]),edge(2,'service',10,[[200,0],[700,0]])]};
 const walk=network(roads)([0,0],[200,0]),drive=network(roads,'drive')([200,0],[700,0]);
 const seconds=(walk.minutes+drive.minutes)*60+10+10+30;
 const feature=(id,x)=>({properties:{id},geometry:{coordinates:[[[pt(x,-1),pt(x+1,0),pt(x,1),pt(x-1,0),pt(x,-1)]]]}});
 const fresh=x=>({lon:pt(x,0)[0],lat:0,time:Date.now(),accuracy:2});
 const calc=planner(roads,[feature(1,700)],[feature(4,450)],[{id:'V',kind:'vehicle'}],new Map([['E',fresh(0)],['V',fresh(200)]]),new Map());
 const itinerary=calc.plan('E',{zone:1,kit:true});
 assert.equal(itinerary.vehicle,'V');assert(Math.abs(itinerary.minutes*60-seconds)<0.001);
 assert(Math.abs(seconds-374)<0.001);assert.equal(Math.round(seconds)+120,494);
 for(const [time,ok] of [[900000,true],[901000,false]]){
  const c={createdAt:0,status:'assigned'};transition(c,'accept',120000);transition(c,'arrive',time);
  assert.equal(c.inLimit,ok);assert.equal(c.arrivedAt,time);
 }
});
test('Полигон: порядок парковка → склад → высадка → борт и остаток пути',()=>{
 const zones=geo('service_zones').features,objects=geo('objects').features,points=new Map(),agents=[{kind:'vehicle',id:'Машина'}];
 setOrigin(geo('airport_boundaries'));
 const at=(id,p)=>points.set(id,{lon:p[0],lat:p[1],time:Date.now(),accuracy:4});
 const parking=objects.find(f=>f.properties.id===3).geometry.coordinates[0][0][0];at('Машина',parking);
 const plan=planner(geo('roads'),zones,objects,agents,points,new Map());
 let example;
 for(const start of zones){at('E',start.geometry.coordinates[0][0][0]);for(const z of zones){
  const r=plan.plan('E',{zone:z.properties.id,kit:true});
  if(r?.vehicle){example={r,z,start};break}
 }if(example)break}
 assert(example);const {r,z}=example;const near=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1])<0.01;
 const i=r.path.findIndex(p=>near(p,r.pickup)),j=r.path.findIndex(p=>near(p,r.store)),k=r.path.findLastIndex(p=>near(p,r.dropoff));
 assert(i>=0&&j>=i&&k>=j);assert(r.alternatives.some(v=>v.mode==='Пешком'));
 const sum=r.path.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-r.path[i][0],p[1]-r.path[i][1]),0);
 assert(Math.abs(sum-r.meters)<0.01);
 const before=plan.plan('E',{zone:z.properties.id});at('E',z.geometry.coordinates[0][0][0]);
 const after=plan.plan('E',{zone:z.properties.id});assert(after.minutes<before.minutes);assert.notDeepEqual(after.path,before.path);
 const close=after.alternatives;assert.equal(after.mode,'Пешком');console.log('Сравнение у зоны',close);
 console.log('Парковка/склад, зона',z.properties.id,r.alternatives,'У борта',after.mode,after.minutes);
});
