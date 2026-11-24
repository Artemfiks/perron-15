import test from 'node:test';
import assert from 'node:assert/strict';
import {forecast,comparePair} from '../deadlines.mjs';

const call={createdAt:100000};
test('Замена использует исходный дедлайн: запас, точная граница и опоздание',()=>{
 const now=call.createdAt+14*60000;
 for(const [minutes,marginMs,inTime] of [[0.5,30000,true],[1,0,true],[1.5,-30000,false]]){
  assert.deepEqual(forecast(call,minutes,now),{eta:now+minutes*60000,deadline:1000000,marginMs,inTime});
 }
});
test('Две срочные работы: сохраняем второго специалиста, затем минимизируем опоздания',()=>{
 const now=call.createdAt;
 function candidate(minutes,remaining){
  return {route:{minutes},forecast:forecast(call,minutes,now),impact:{remaining:remaining==null?null:forecast(call,remaining,now)}};
 }
 assert(comparePair(candidate(5,10),candidate(2,null))<0);
 assert(comparePair(candidate(5,14),candidate(2,16))<0);
 assert(comparePair(candidate(16,8),candidate(3,22))<0);
});
