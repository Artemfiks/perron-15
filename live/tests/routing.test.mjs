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
