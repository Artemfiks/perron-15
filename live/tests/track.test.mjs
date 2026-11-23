import test from 'node:test';import assert from 'node:assert/strict';import {track} from '../track.mjs';
test('Пакет, одиночная точка, три роли, неизвестный объект, 400 и устаревание',()=>{
 const ids=['e-01','v-01','RA-73142'],agents=ids.map(obj=>({obj,id:obj})),points=new Map(),p=obj=>({obj,lat:55.8312,lon:37.6359});
 const result=track({points:[...ids,'other'].map(p)},agents,points);
 assert.deepEqual(result.map(r=>r.applied),[true,true,true,false]);assert.deepEqual(result.map(r=>r.obj),[...ids,'other']);
 assert.equal(track({...p(ids[0]),t:'2020-01-01T00:00:00Z'},agents,points).applied,false);
 assert.throws(()=>track({points:[p('new'),{lat:'abc'}]},agents,points),{status:400});assert.equal(points.size,3);
});
