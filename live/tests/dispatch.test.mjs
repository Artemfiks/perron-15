import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {journal} from '../journal.mjs';

test('Автоотправка, отказ, таймер без браузера, GPS борта и норматив',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'perron-auto-'));
 const file=join(directory,'shift.db');
 const overdue={number:1,status:'pending',createdAt:Date.now()-901000,zone:1,priority:'A',ata:98,aircraft:'A320'};
 const initial=journal(file);initial.record('registered','Тест',overdue,{}, {calls:[overdue],pending:[1],jobs:[]});initial.close();
 const proc=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',STATE_DB:file,RENDER:'test',DISPATCH_CODE:'dispatch',ENGINEER_ONE_CODE:'one',ENGINEER_TWO_CODE:'two',OFFER_TIMEOUT_MS:'1800'},stdio:['ignore','pipe','inherit']});
 try{
  const [out]=await once(proc.stdout,'data'),origin=String(out).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  async function api(path,session,body,expected=200){
   const r=await fetch(origin+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{cookie:session||'','Content-Type':'application/json'},body:JSON.stringify(body)});
   const text=await r.text();assert.equal(r.status,expected,path+' '+text.slice(0,150));
   if(path==='login')return r.headers.get('set-cookie').split(';')[0];
   return path==='log.csv'?text:JSON.parse(text);
  }
  const d=await api('login','',{role:'dispatcher',code:'dispatch'}),a=await api('login','',{role:'engineer',code:'one'}),b=await api('login','',{role:'engineer',code:'two'});
  const zones=JSON.parse(await readFile(new URL('../data/service_zones.geojson',import.meta.url))).features;
  const point=(obj,zone)=>{
   const ring=zones.find(z=>z.properties.id===zone).geometry.coordinates[0][0].slice(0,-1);
   return {obj,lat:ring.reduce((v,p)=>v+p[1],0)/ring.length,lon:ring.reduce((v,p)=>v+p[0],0)/ring.length,acc:3};
  };
  await api('roster',d,{obj:'e-02',kind:'engineer',ata:[34]});
  await api('v1/track',d,{points:[point('e-01',7),point('e-02',2),point('RA-73142',7)]});
  const form={zone:2,tail:'RA-73142',aircraft:'A320',defect:'NAV',priority:'B'};
  const call=await api('calls',d,form);
  assert.equal(call.offers[0].engineer,'Инженер 1');
  assert.equal((await api('job',a)).arrivalZone,7);
  await api('action',a,{number:call.number,action:'reject'});
  assert.equal((await api('job',b)).number,call.number);
  await api('action',a,{number:call.number,action:'accept'},409);
  await api('action',b,{number:call.number,action:'accept'});
  await api('v1/track',b,point('e-02',2));assert.equal((await api('job',b)).status,'enroute');
  await api('v1/track',b,point('e-02',7));assert.equal((await api('job',b)).inLimit,true);
  await api('action',b,{number:call.number,action:'start'});await api('action',b,{number:call.number,action:'done'});
  await api('availability',a,{minutes:20});await api('v1/track',b,point('e-02',2));
  const next=await api('calls',d,form);assert.equal(next.offers[0].engineer,'Инженер 2');
  await api('availability',a,{minutes:0});
  await sleep(3000);
  const forwarded=await api('job',a);assert.equal(forwarded.number,next.number);
  assert.deepEqual(forwarded.offers.map(o=>o.outcome),['timeout','offered']);
  assert.equal(forwarded.createdAt,next.createdAt);
  await api('action',b,{number:next.number,action:'accept'},409);
  await api('action',a,{number:next.number,action:'accept'});
  const history=await api('dispatch',d);
  assert.equal(history.find(c=>c.number===call.number).offers[1].outcome,'accepted');
  assert(history.find(c=>c.number===1).breachAt);
  // A late GPS arrival must close the same original 15-minute deadline.
  await api('roster',d,{obj:'e-02',kind:'engineer',ata:[98]});
  await api('availability',b,{minutes:0});
  assert.equal((await api('job',b)).number,overdue.number);
  await api('action',b,{number:overdue.number,action:'accept'});
  await api('v1/track',b,point('e-02',1));
  assert.equal((await api('job',b)).inLimit,false);
  const csv=await api('log.csv',d);
  assert.equal(csv.split('deadline-breach').length-1,1);
  for(const name of ['offer-timeout','offer-rejected','arrival','deadline-breach','availability'])assert(csv.includes(name));
 }finally{
  const done=once(proc,'exit');proc.kill();await done;await rm(directory,{recursive:true,force:true});
 }
});
