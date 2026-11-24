import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {xy,center,network} from '../route.js';import {planner} from '../planning.mjs';
const geo=n=>JSON.parse(readFileSync(new URL('../data/'+n+'.geojson',import.meta.url)));
test('90 направлений ВДНХ; закрытия и скорости',()=>{
 const config=JSON.parse(readFileSync(new URL('../site.json',import.meta.url))),objects=geo('objects').features,roads=geo('roads'),z=geo('service_zones').features.map(center),walk=network(roads,'walk',[],objects.filter(o=>config.blockedObjects.includes(o.properties.id)));
 const runway=center(objects.find(o=>o.properties.name.includes('полоса')));assert.equal(walk(runway,z[0]),null);
 for(const a of z)for(const b of z)if(a!==b)assert(walk(a,b));
 const f=roads.features.find(f=>f.properties.spd_kmh===20&&f.properties.type==='service');
 const single={features:[f]},start=xy(f.geometry.coordinates[0]),end=xy(f.geometry.coordinates.at(-1));
 assert(network(single,'drive')(start,end).minutes<network(single)(start,end).minutes);
 assert.equal(network(single,'drive',[f.properties.id])(start,end),null);
});
test('Пересадка, склад и прямой пеший вариант',()=>{
 const roads=geo('roads'),zones=geo('service_zones').features,objects=geo('objects').features;
 const agents=[{id:'V',kind:'vehicle'}],points=new Map(),p=zones[8].geometry.coordinates[0][0][0];
 for(const id of ['E','V'])points.set(id,{lon:p[0],lat:p[1],time:Date.now(),accuracy:5});
 const r=planner(roads,zones,objects,agents,points,new Map());assert.equal(r.plan('E',{zone:1}).vehicle,'V');
 assert(r.plan('E',{zone:1,kit:true}).store);assert.equal(r.plan('E',{zone:9}).mode,'Пешком');
});
test('Зона 4: GPS в терминале и выход на разрешённую дорожку',()=>{
 const zones=geo('service_zones').features,objects=geo('objects').features,points=new Map();
 const terminal=objects.find(f=>f.properties.name==='Терминал');
 const ring=terminal.geometry.coordinates[0][0];
 const p=ring.slice(0,-1).reduce((s,q)=>[s[0]+q[0]/(ring.length-1),s[1]+q[1]/(ring.length-1)],[0,0]);
 const locate=([lon,lat])=>points.set('E',{lon,lat,time:Date.now(),accuracy:29});
 const r=planner(geo('roads'),zones,objects,[],points,new Map());
 locate(p);assert.equal(r.plan('E',{zone:4}),null);assert.match(r.unavailable('E',{zone:4}),/«Терминал»/);
 locate(zones[1].geometry.coordinates[0][0][0]);assert(r.plan('E',{zone:4}));
});
