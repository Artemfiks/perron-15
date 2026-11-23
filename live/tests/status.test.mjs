import test from 'node:test';import assert from 'node:assert/strict';import {transition,insideZone} from '../lifecycle.mjs';
test('Порядок статусов, дедлайн и реальный полигон с отверстием',()=>{
 const c={status:'assigned',createdAt:100};
 assert.throws(()=>transition(c,'done',110));
 for(const [a,t] of [['accept',120],['arrive',900100],['start',900101],['done',900102]])transition(c,a,t);
 assert.equal(c.inLimit,true);assert.equal(c.arrivedAt,900100);
 const f={geometry:{coordinates:[[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]]]}};
 assert(insideZone([3,3],f));assert(!insideZone([1.5,1.5],f));assert(!insideZone([5,3],f));
});
