import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
