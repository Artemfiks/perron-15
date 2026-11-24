import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {network,setOrigin} from '../route.js';
import {forbiddenObjects,positionStatus} from '../access.mjs';

const layer=name=>JSON.parse(readFileSync(new URL('../data/'+name+'.geojson',import.meta.url)));
const bounds=layer('airport_boundaries'),roads=layer('roads'),zones=layer('service_zones');
const ids=JSON.parse(readFileSync(new URL('../site.json',import.meta.url))).blockedObjects;
const barriers=forbiddenObjects(layer('objects').features,ids);
setOrigin(bounds);
const walk=network(roads,'walk',[],barriers);
const now=Date.now();
const at=([lon,lat],accuracy=1,time=now)=>({lon,lat,time,accuracy});
const status=p=>positionStatus(p,barriers,bounds.features,walk,now);
test('Карта ВДНХ различает запрет, границу с погрешностью, доступную дорожку и отсутствие GPS',()=>{
 for(const f of barriers){
  const ring=f.geometry.coordinates[0][0].slice(0,-1);
  const mid=ring.reduce(([x,y],[u,v])=>[x+u/ring.length,y+v/ring.length],[0,0]);
  assert.equal(status(at(mid)).level,'blocked',f.properties.name);
  assert.equal(status(at(ring[0],5)).level,'uncertain');
 }
 const p=zones.features[0].geometry.coordinates[0][0][0];
 assert.equal(status(at(p)).level,'open');
 assert.equal(positionStatus(at(p),barriers,bounds.features,network(roads,'walk',roads.features.map(f=>f.properties.id),barriers),now).level,'outside');
 assert.equal(status(at([0,0])).level,'outside');
 assert.equal(status(at(p,51)).level,'uncertain');
 assert.equal(status(at(p,1,now-61000)).level,'unknown');
 assert.equal(status(null).level,'unknown');
});
