import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('Смена через HTTP: две роли инженера, два AOG, ожидание, замена, MEL, журнал и восстановление',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'perron-test-'));
 let child,base;
 async function start(){
  child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',STATE_DB:join(directory,'shift.db'),RENDER:'test',DISPATCH_CODE:'test-d',ENGINEER_ONE_CODE:'test-a',ENGINEER_TWO_CODE:'test-b',TRACK_KEY:'test-feed'},stdio:['ignore','pipe','inherit']});
  const [out]=await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('Сервер остановился')})]);base=out.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
 }
 async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done}}
 async function req(path,session,body,status=200){
  const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(session==='feed'?{authorization:'Bearer test-feed'}:{cookie:session||''})},body:JSON.stringify(body)});
  const data=await r.text();assert.equal(r.status,status,path+' '+data.slice(0,180));
  if(path==='login')return r.headers.get('set-cookie').split(';')[0];
  return path==='log.csv'?data:JSON.parse(data);
 }
 const login=(role,code)=>req('login',null,{role,code});
 const zones=JSON.parse(await readFile(new URL('../data/service_zones.geojson',import.meta.url))).features;
 const gps=(obj,i)=>{const vertices=zones[i].geometry.coordinates[0][0].slice(0,-1);return {obj,lon:vertices.reduce((s,p)=>s+p[0],0)/vertices.length,lat:vertices.reduce((s,p)=>s+p[1],0)/vertices.length,acc:4}};
 try{
  await start();let d=await login('dispatcher','test-d');const a=await login('engineer','test-a'),b=await login('engineer','test-b');
  await req('v1/track','feed',{obj:'e-01',lat:'bad'},400);
  assert.equal((await req('v1/track','feed',gps('unknown',1))).applied,false);
  const rows=await req('v1/track','feed',{points:['e-01','e-02','v-01','RA-73142'].map(o=>gps(o,1))});assert(rows.every(r=>r.applied));
  await req('v1/track',a,gps('e-02',0),403);
  const beacon=await req('beacon',d,{obj:'v-01'});
  const vehiclePoint=async obj=>fetch(base+'/api/v1/track',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+beacon.key},body:JSON.stringify(gps(obj,1))});
  assert.equal((await vehiclePoint('v-01')).status,200);assert.equal((await vehiclePoint('e-01')).status,401);
  await req('competition-feed',d,{enable:true});await req('v1/track',null,gps('RA-73142',0));await req('competition-feed',d,{enable:false});await req('v1/track',null,gps('RA-73142',0),401);
  const remark=await req('remarks',a,{note:'Замечание с борта'});assert.equal((await req('remarks',d))[0].id,remark.id);
  const form={zone:zones[0].properties.id,priority:'A',aircraft:'A320',tail:'TEST-01'};
  const first=await req('calls',d,{...form,text:'Тест навигации',ata:34,remarkId:remark.id,scheduled:new Date().toISOString()});
  const second=await req('calls',d,{...form,defect:'HYD'});assert.equal((await req('calls',d)).length,2);
  assert.deepEqual(await req('remarks',d),[]);
  const assign=async c=>{const list=await req('rank?number='+c.number,d);assert(list[0].route);assert(list.some(x=>x.reason));await req('assign',d,{number:c.number,id:list[0].id,time:list[0].time,zone:c.zone})};
  const action=(s,c,action,status=200)=>req('action',s,{number:c.number,action},status);
  await assign(first);await action(a,first,'reject');await assign(first);await assign(second);
  for(const [s,c,obj] of [[a,first,'e-01'],[b,second,'e-02']]){
   await action(s,c,'accept');await action(s,c,'done',409);
   await req('v1/track',s,gps(obj,0));assert.equal((await req('job',s)).status,'arrived');
   await action(s,c,'start');await req('decision',s,{number:c.number,decision:'AOG'});
  }
  const current=await req('team',d);assert.equal(current.filter(e=>e.job?.aog).length,2);assert(current.every(e=>e.job.aircraftNear==='RA-73142'));
  await action(b,second,'wait');assert.equal(await req('job',b),null);
  await req('control',a,{number:first.number,reason:'Запчасть'},403);
  await req('control',d,{number:second.number,reason:'Деталь доставлена'});
  await assign(second);await action(b,second,'accept');await req('v1/track',b,gps('e-02',0));
  await action(b,second,'start');await req('decision',b,{number:second.number,decision:'B',until:new Date(Date.now()+86400000).toISOString()});
  await action(b,second,'done');await action(a,first,'done');
  const next=await req('calls',d,{...form,defect:'NAV'});assert.equal(next.melHistory[0].number,second.number);
  const metrics=await req('metrics',d);assert.equal(metrics.arrived,2);assert.equal(metrics.onTime,2);assert.equal(metrics.withoutArrival,1);assert(metrics.meanSelectionMs>=0);
  const csv=await req('log.csv',d);for(const k of ['registered','remark','candidates','assigned','arrival','route-update','reassignment','engineering-decision','track-error','aircraft-schedule'])assert(csv.includes(k),k);
  const extra=await req('roster',d,{obj:'extra',kind:'engineer',ata:[34],models:['A320']});
  await stop();await start();d=await login('dispatcher','test-d');await login('engineer',extra.code);
  assert.deepEqual(await req('metrics',d),metrics);assert.equal((await req('calls',d))[0].number,next.number);
 }finally{await stop();await rm(directory,{recursive:true,force:true})}
});
