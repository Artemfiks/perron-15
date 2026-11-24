import http from 'node:http';
import https from 'node:https';
import {readFileSync,mkdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {aircraft,defects,priorities} from './calls.mjs';
import {track} from './track.mjs';
import {journal} from './journal.mjs';
import {homedir,tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const agents=JSON.parse(readFileSync(new URL('./agents.json',import.meta.url)));
const feedKey=process.env.TRACK_KEY || randomBytes(24).toString('hex');
import {transition,insideZone} from './lifecycle.mjs';
import {xy,setOrigin} from './route.js';
import {planner} from './planning.mjs';
import {forecast,comparePair} from './deadlines.mjs';
const layer=n=>JSON.parse(readFileSync(new URL('./data/'+n+'.geojson',import.meta.url)));
const zones=layer('service_zones').features;
setOrigin(layer('airport_boundaries'));
const roads=layer('roads');
const extraAccounts=new Map();
const digest=s=>createHash('sha256').update(s).digest('hex');
const remarks=new Map();
let feedUntil=0;
const history=new Map();
function onPosition(agent,point){
 if(agent.kind==='vehicle')for(const [id,c] of jobs){
  if(c.arrivedAt)continue;
  const r=routing.plan(id,c);db.record('route-update',id,c,{trigger:agent.obj,forecast:r?Date.now()+r.minutes*60000:null,mode:r?.mode});
 }
 const call=jobs.get(agent.id);
 if(call?.vehicle&&!call.boarded&&call.status==='enroute'){
  const v=points.get(call.vehicle);
  if(v&&Date.now()-v.time<=60000&&Math.abs(v.time-point.time)<=60000&&v.accuracy<=30&&point.accuracy<=30){
   const [x,y]=xy([point.lon,point.lat]),[u,w]=xy([v.lon,v.lat]);
   if(Math.hypot(x-u,y-w)<=12){call.boarded=true;log('vehicle-pickup',agent.id,call,{vehicle:call.vehicle})}
  }
 }
 if(call&&!call.arrivedAt){const r=routing.plan(agent.id,call),forecast=r?point.time+r.minutes*60000:null;
  db.record('route-update',agent.id,call,{forecast,mode:r?.mode,meters:r?.meters});
  if(!forecast||forecast>call.createdAt+900000)db.record('risk','Диспетчер',call,{forecast,deadline:call.createdAt+900000});
 }
 if(call?.store&&!call.kitCollected&&call.status==='enroute'&&point.time>=call.acceptedAt&&Date.now()-point.time<=60000&&point.accuracy<=50){const pos=xy([point.lon,point.lat]);if(Math.hypot(pos[0]-call.store[0],pos[1]-call.store[1])<=12){call.kitCollected=true;log('kit-collected',agent.id,call)}}
 if(call?.status==='enroute'&&(!call.kit||call.kitCollected)&&point.time>=call.acceptedAt&&Date.now()-point.time<=60000&&point.accuracy<=50&&insideZone([point.lon,point.lat],zones.find(z=>z.properties.id===call.zone))){
   transition(call,'arrive',point.time);
   log('arrival',agent.id,call,{arrivedAt:point.time,inLimit:call.inLimit,elapsedSeconds:(point.time-call.createdAt)/1000});
   if(!call.inLimit)log('deadline-breach',agent.id,call);
 }
}
function activeView(id){
 const c=jobs.get(id),p=points.get(id);
 if(!c)return null;
 const route=routing.plan(id,c);
 const now=Date.now(),eta=route?forecast(c,route.minutes,now).eta:null;
 const risk=!c.arrivedAt&&(!eta||eta>c.createdAt+900000);
 const replacement=risk?candidates(c,now).find(x=>x.route):null;
 const alternate=replacement?{id:replacement.id,minutes:replacement.route.minutes,...replacement.forecast}:null;
 const aircraftNear=p&&agents.filter(a=>a.kind==='aircraft').find(a=>{
  const q=points.get(a.id);if(!q||Date.now()-q.time>60000||Date.now()-p.time>60000)return false;
  const [x,y]=xy([q.lon,q.lat]),[u,v]=xy([p.lon,p.lat]);return Math.hypot(x-u,y-v)<75;
 });
 if((aircraftNear?.id||null)!==(c.nearbyAircraft||null)){c.nearbyAircraft=aircraftNear?.id||null;log('aircraft-proximity',id,c,{aircraft:c.nearbyAircraft,thresholdMeters:75})}
 const riskKey=risk?JSON.stringify([alternate?.id,alternate?.inTime]):'';
 if(riskKey!==(c.lastRiskKey||'')){c.lastRiskKey=riskKey;log('forecast-risk',id,c,{risk,eta,deadline:c.createdAt+900000,alternate})}
 return {...c,route,point:p,eta,risk,alternate,aircraftNear:aircraftNear?.id};
}

const accounts = new Map();
const sessions = new Map();
const beacons=new Map();
const points = new Map();
const jobs = new Map();
const routing=planner(roads,zones,layer('objects').features,agents,points,jobs);
function candidates(c,now,reservedVehicle){
 return agents.filter(a=>a.kind==='engineer').map(a=>{
   const p=points.get(a.id),job=jobs.get(a.id);
   const reason=job?'Занят · '+job.status:!a.ata.includes(c.ata)?'Нет допуска ATA '+c.ata:a.models&&!a.models.includes(c.aircraft)?'Нет допуска на '+c.aircraft:!p?'Ожидаем GPS':Date.now()-p.time>60000?'Координаты устарели':p.accuracy>50?'Низкая точность GPS':'';
   const route=reason?null:routing.plan(a.id,c,reservedVehicle);
   return {id:a.id,time:p?.time,route,forecast:route?forecast(c,route.minutes,now):null,reason:reason||(!route?routing.unavailable(a.id,c):'')};
 }).sort((a,b)=>(a.route?.minutes??Infinity)-(b.route?.minutes??Infinity));
}
function queueOrder(a,b){return Number(!!b.aog)-Number(!!a.aog)||a.priority.localeCompare(b.priority)||a.createdAt-b.createdAt||a.number-b.number}
function rank(c){
 const started=performance.now(),now=Date.now(),result=candidates(c,now);
 const other=[...pending.values()].filter(j=>j.number!==c.number&&(j.aog||j.priority==='A')).sort(queueOrder)[0];
 if(other){
  const baseline=candidates(other,now),byVehicle=new Map([[undefined,baseline]]);
  for(const row of result.filter(row=>row.route)){
   const vehicle=row.route.vehicle;
   if(!byVehicle.has(vehicle))byVehicle.set(vehicle,candidates(other,now,vehicle));
   const next=byVehicle.get(vehicle).find(x=>x.route&&x.id!==row.id);
   row.impact={number:other.number,baseline:baseline[0]?.forecast||null,engineer:next?.id,remaining:next?.forecast||null};
  }
  result.sort((a,b)=>a.route&&b.route?comparePair(a,b):Number(!!b.route)-Number(!!a.route));
 }
 const signature=JSON.stringify(result.map(r=>[r.id,r.time,r.reason,r.route?.minutes,r.route?.mode,r.forecast?.inTime,r.impact?.number,r.impact?.engineer,r.impact?.remaining?.inTime,r.impact?.remaining?.eta-now]));
 if(c.rankSignature!==signature){c.rankSignature=signature;log('candidates','Система',c,{durationMs:performance.now()-started,candidates:result.map(r=>({id:r.id,reason:r.reason,mode:r.route?.mode,minutes:r.route?.minutes,forecast:r.forecast,impact:r.impact}))})}
 return result;
}
const pending = new Map();
let nextCall = 1;
const dbFile=process.env.STATE_DB||join(process.env.RENDER?tmpdir():homedir(),'.perron-15','shift.sqlite');
mkdirSync(dirname(dbFile),{recursive:true});const db=journal(dbFile);
const saved=db.restore();
if(saved){
 if(saved.agents)agents.splice(0,agents.length,...saved.agents);
 for(const [key,a] of saved.extraAccounts||[])extraAccounts.set(key,a);
 for(const r of saved.remarks||[])remarks.set(r.id,r);
 for(const c of saved.calls)history.set(c.number,c);
 for(const n of saved.pending)pending.set(n,history.get(n));
 for(const [id,n] of saved.jobs)jobs.set(id,history.get(n));
 nextCall=Math.max(0,...history.keys())+1;
 routing.close(saved.closed||[]);
 for(const [k,v] of Object.entries(saved.defects||{}))defects[k]=v;
}
function log(kind,actor,c,detail={}){
 db.record(kind,actor,c,detail,{calls:[...history.values()],pending:[...pending.keys()],jobs:[...jobs].map(([id,j])=>[id,j.number]),closed:routing.closed,defects,agents,extraAccounts:[...extraAccounts],remarks:[...remarks.values()]});
}
const backgroundKeys=new Map();
const attempts = new Map();
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const port = Number(process.env.PORT || (process.env.RENDER?10000:8175));
const host = process.env.HOST || (process.env.RENDER?'0.0.0.0':'127.0.0.1');
if (!tls && !['127.0.0.1','localhost','::1'].includes(host) && process.env.TRUST_HTTPS_PROXY !== 'yes') {
  throw Error('Для сети настройте HTTPS (TLS_CERT и TLS_KEY) или защищённый обратный прокси.');
}
for (const [id,role] of [['Диспетчер','dispatcher'],['Инженер 1','engineer'],['Инженер 2','engineer']]) {
  const code = process.env[['DISPATCH_CODE','ENGINEER_ONE_CODE','ENGINEER_TWO_CODE'][accounts.size]] || randomBytes(8).toString('hex');
  accounts.set(code,{id,role,obj:agents.find(a=>a.id===id)?.obj});
}
const files = new Map(Object.entries({
  '/':['index.html','text/html'], '/ui.js':['ui.js','text/javascript'],
  '/access.mjs':['access.mjs','text/javascript'],
  '/route.js':['route.js','text/javascript'], '/style.css':['style.css','text/css'],
  '/scenarios':['scenarios.html','text/html'],
  '/calls.mjs':['calls.mjs','text/javascript'],
  '/lifecycle.mjs':['lifecycle.mjs','text/javascript'],
  '/site.json':['site.json','application/json'],
  '/beacon':['beacon.html','text/html'],
  ...Object.fromEntries(['roads','objects','airport_boundaries','service_zones'].map(n=>['/data/'+n,['data/'+n+'.geojson','application/json']]))
}));
function fail(status,message){throw Object.assign(Error(message),{status});}
async function handle(req,res){
 const path = req.url.split('?')[0];
 if((req.method==='GET'||req.method==='HEAD')&&path==='/healthz'){res.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});return res.end(req.method==='HEAD'?'':'ready')}
 if(req.method==='HEAD'&&path==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end()}
 const post = req.method === 'POST';
 if (!post && req.method !== 'GET') fail(405,'Метод недоступен');
 const token = /(?:^|; *)shift=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
 const session = sessions.get(token);
 const user = session?.until > Date.now() ? session.user : null;
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 const send = data => {res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(data));};
 let body={};
 if(post){
   if(req.headers['content-type']?.split(';')[0]!=='application/json') fail(415,'Ожидается JSON');
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>262144)fail(413,'Слишком большой запрос');chunks.push(chunk)}
   const raw=Buffer.concat(chunks).toString('utf8');
   try{body=!raw&&path==='/api/owntracks'?{}:JSON.parse(raw);}catch{fail(400,'Ошибка данных');}
   if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Ошибка данных');
 }
 if(path==='/api/login' && post){
   const ip=req.socket.remoteAddress;
   const recent=(attempts.get(ip)||[]).filter(t=>Date.now()-t<60000);
   if(recent.length>=12)fail(429,'Попробуйте через минуту');
   const account=typeof body.code==='string'&&(accounts.get(body.code)||extraAccounts.get(digest(body.code)));
   if(!account || account.role!==body.role){attempts.set(ip,[...recent,Date.now()]);fail(401,'Проверьте роль и код смены');}
   const sid=randomBytes(32).toString('hex');
   sessions.set(sid,{user:account,until:Date.now()+12*3600000});
   res.setHeader('Set-Cookie','shift='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(tls || process.env.TRUST_HTTPS_PROXY==='yes'?'; Secure':''));
   return send(account);
 }
 if(path==='/api/background-key'&&post&&user?.role==='engineer'){
  if(body.revoke===true){backgroundKeys.delete(user.obj);return send({});}
  const password=randomBytes(24).toString('hex');
  backgroundKeys.set(user.obj,{hash:digest(password),until:session.until,session:token});
  return send({username:user.obj,password,until:session.until});
 }
 if(path==='/api/owntracks'&&post){
  const credential=req.headers.authorization||'';
  const [obj,password]=credential.startsWith('Basic ')?Buffer.from(credential.slice(6),'base64').toString().split(':'):[];
  const key=backgroundKeys.get(obj);
  if(!key||key.until<=Date.now()||!password||digest(password)!==key.hash)fail(401,'Проверьте подключение телефона к смене');
  if(body._type==='location'){
   if(!Number.isSafeInteger(body.tst)||body.tst<=0||body.tst>8.64e12||!Number.isFinite(body.acc))fail(400,'Нужны время и точность GPS');
   const stamp=body.tst*1000;
   if(stamp>=Date.now()-60000)track({obj,lat:body.lat,lon:body.lon,acc:body.acc,t:new Date(stamp).toISOString()},agents,points,onPosition);
  }
  return send([]);
 }
 if(path==='/api/me' && !post)return send(user);
 if(path==='/api/track-key' && !post && user?.role==='dispatcher')return send({key:feedKey});
 if(path==='/api/beacon'&&post&&user?.role==='dispatcher'){
  const a=agents.find(a=>a.obj===body.obj&&a.kind==='vehicle');if(!a)fail(400,'Укажите ID транспорта');
  const key=randomBytes(24).toString('hex');beacons.set(key,{obj:a.obj,until:Date.now()+12*3600000});return send({key,obj:a.obj});
 }
 if(path==='/api/competition-feed'&&post&&user?.role==='dispatcher'){feedUntil=body.enable?Date.now()+3600000:0;log('competition-feed',user.id,null,{feedUntil});return send({feedUntil})}
 if(path==='/api/v1/track' && post){
  const beacon=beacons.get(req.headers.authorization?.slice(7));
  const external=req.headers.authorization==='Bearer '+feedKey||(!user&&Date.now()<feedUntil)||(beacon?.until>Date.now()&&body.obj===beacon.obj&&!Object.hasOwn(body,'points'));
  if(!external&&!user)fail(401,'Нужен ключ источника');
  if(!external&&user.role==='engineer'&&(body.obj!==user.obj||Object.hasOwn(body,'points')))fail(403,'Доступ только к своей позиции');
  try{const result=track(body,agents,points,onPosition);for(const r of [].concat(result))if(!r.applied)db.record('track-not-applied','Источник',null,r);return send(result)}
  catch(e){db.record('track-error','Источник',null,{message:e.message});throw e}
 }
 if(path==='/api/agents'&&!post&&user)return send(agents.filter(a=>user.role==='dispatcher'||a.id===user.id||a.kind!=='engineer').map(a=>({...a,point:points.get(a.id)})));
 if(path==='/api/roster'&&post&&user?.role==='dispatcher'){
  const {obj,kind,ata}=body;
  if(typeof obj!=='string'||!/^[-\w]{1,32}$/.test(obj)||!['engineer','vehicle','aircraft'].includes(kind)||!Array.isArray(ata)||ata.some(n=>!Number.isInteger(n)||n<1||n>99))fail(400,'Проверьте идентификатор, тип и допуски');
  let a=agents.find(a=>a.obj===obj);if(a&&a.kind!==kind)fail(409,'Тип существующего объекта изменить нельзя');
  let code=null;
  if(body.models!==undefined&&(!Array.isArray(body.models)||body.models.some(m=>!aircraft.includes(m))))fail(400,'Проверьте типы ВС');
  if(!a){a={id:obj,obj,kind};agents.push(a);if(kind==='engineer'){code=randomBytes(12).toString('hex');extraAccounts.set(digest(code),{id:obj,obj,role:kind})}}
  if(body.models)a.models=body.models;
  a.ata=ata;log('roster',user.id,null,{obj,kind,ata});return send({obj,code});
 }
 if(path==='/api/roads'&&user&&(!post||user.role==='dispatcher')){
  if(post){if(!Array.isArray(body.ids)||body.ids.some(i=>!roads.features.some(f=>f.properties.id===i)))fail(400,'Проверьте ID рёбер');routing.close(body.ids)}
  if(post)log('road-closures',user.id,null,{ids:routing.closed});
  return send(routing.closed);
 }
 if(path==='/api/rank'&&user?.role==='dispatcher'&&!post){
  const c=pending.get(Number(new URL(req.url,'http://localhost').searchParams.get('number')));
  return send(c?rank(c):[]);
 }
 if(path.startsWith('/api/') || path.startsWith('/data/') || path==='/scenarios'){
   if(!user)fail(401,'Войдите в смену');
 }
 if(path==='/api/logout' && post){sessions.delete(token);if(backgroundKeys.get(user.obj)?.session===token)backgroundKeys.delete(user.obj);if(user.role==='engineer')points.delete(user.id);res.setHeader('Set-Cookie','shift=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');return send({});}
 if(path==='/api/point' && post && user.role==='engineer'){
   if(body.stop){points.delete(user.id);return send({});}
   const {lat,lon,accuracy,time}=body;
   if(![lat,lon,accuracy,time].every(Number.isFinite)||Math.abs(lat)>90||Math.abs(lon)>180||accuracy<0||Date.now()-time>60000||time>Date.now()+5000)fail(400,'Координаты устарели или некорректны');
   track({obj:user.obj,lat,lon,acc:accuracy,t:new Date(time).toISOString()},agents,points,onPosition);
   return send({});
 }
 if(path==='/api/log.csv'&&!post&&user.role==='dispatcher'){res.setHeader('Content-Type','text/csv;charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="perron-events.csv"');return res.end(db.csv())}
 if(path==='/api/team' && !post && user.role==='dispatcher')return send(agents.filter(a=>a.kind==='engineer').map(a=>({id:a.id,point:points.get(a.id),job:activeView(a.id)})));
 if(path==='/api/metrics'&&!post&&user.role==='dispatcher')return send(db.metrics());
 if(path==='/api/remarks'&&user.role==='engineer'&&post){
  const note=typeof body.note==='string'?body.note.trim():'';
  if(!note||note.length>300)fail(400,'Введите до 300 символов');
  const r={id:randomBytes(6).toString('hex'),author:user.id,note,at:Date.now()};remarks.set(r.id,r);log('remark',user.id,null,r);return send(r);
 }
 if(path==='/api/remarks'&&user.role==='dispatcher'&&!post)return send([...remarks.values()].filter(r=>!r.call));
 if(path==='/api/catalog'&&!post)return send(defects);
 if(path==='/api/job' && !post && user.role==='engineer')return send(activeView(user.id));
 if(path==='/api/tool'&&post&&user.role==='engineer'){
  const c=jobs.get(user.id);if(!c||c.number!==body.number||!c.kit||typeof body.collected!=='boolean')fail(409,'Проверьте задание и комплект');
  c.kitCollected=body.collected;
  if(!c.kitCollected)c.store=routing.plan(user.id,c)?.store;
  log('kit-status',user.id,c,{collected:c.kitCollected});return send(c);
 }
 if(path==='/api/decision'&&post&&user.role==='engineer'){
  const c=jobs.get(user.id);if(!c||c.number!==body.number||c.status!=='working')fail(409,'Решение доступно при выполнении работ');
  if(!['AOG','A','B','C','D'].includes(body.decision))fail(400,'Неизвестная категория');
  if(body.decision!=='AOG'&&!(Date.parse(body.until)>Date.now()))fail(400,'Укажите будущий срок отложения');
  c.aog=body.decision==='AOG';c.mel=c.aog?null:body.decision;c.until=c.aog?null:body.until;
  log('engineering-decision',user.id,c,{aog:c.aog,mel:c.mel,until:c.until});return send(c);
 }
 if(path==='/api/control'&&post&&user.role==='dispatcher'){
  const c=history.get(body.number);
  if(!c||!['working','waiting','assigned','enroute','arrived'].includes(c.status)||typeof body.reason!=='string'||!body.reason.trim())fail(409,'Укажите действующую заявку и причину');
  const from=c.status;for(const [id,j] of jobs)if(j.number===c.number)jobs.delete(id);
  c.status='pending';delete c.vehicle;delete c.boarded;c.previousArrival=c.arrivedAt;delete c.arrivedAt;delete c.acceptedAt;
  pending.set(c.number,c);log('reassignment',user.id,c,{from,reason:body.reason});return send(c);
 }
 if(path==='/api/history'&&!post&&user.role==='dispatcher')return send([...history.values()].map(c=>({number:c.number,status:c.status,zone:c.zone,aog:c.aog})));
 if((path==='/api/action'||path==='/api/done')&&post&&user.role==='engineer'){
   const call=jobs.get(user.id);
   if(!call||call.number!==body.number)fail(409,'Назначение изменилось');
   const action=path==='/api/done'?'done':body.action;
   if(!['accept','reject','start','done','wait'].includes(action))fail(400,'Недоступное действие');
   transition(call,action,Date.now());
   if(action==='reject'){pending.set(call.number,call);jobs.delete(user.id)}
   if(action==='done')jobs.delete(user.id);
   if(action==='wait')jobs.delete(user.id);
   if(action==='accept'&&points.has(user.id))onPosition(user,points.get(user.id));
   log('status',user.id,call,{action,status:call.status});
   return send(call);
 }
 if(path==='/api/calls' && user.role==='dispatcher'){
   if(!post)return send([...pending.values()].sort(queueOrder));
   let {zone,aircraft:type,defect,priority}=body;
   const custom=typeof body.text==='string'?body.text.trim():'';
   if(custom&&(custom.length>300||!Number.isInteger(body.ata)||body.ata<1||body.ata>99))fail(400,'Проверьте описание и главу ATA');
   if(!zones.some(z=>z.properties.id===zone)||!aircraft.includes(type)||(!custom&&!Object.hasOwn(defects,defect))||!Object.hasOwn(priorities,priority))fail(400,'Проверьте параметры вызова');
   const tail=body.tail??'';
   const remark=body.remarkId&&remarks.get(body.remarkId);
   if(body.remarkId&&(!remark||remark.call))fail(409,'Замечание уже обработано или не найдено');
   if(body.scheduled&&!Number.isFinite(Date.parse(body.scheduled)))fail(400,'Проверьте время прибытия ВС');
   if(typeof tail!=='string'||tail.length>24)fail(400,'Проверьте номер борта');
   if(custom){defect=Object.keys(defects).find(k=>defects[k][0]===custom&&defects[k][1]==='ATA '+body.ata)||'CUSTOM-'+randomBytes(6).toString('hex');defects[defect]=[custom,'ATA '+body.ata]}
   const call={number:nextCall++,createdAt:Date.now(),status:'pending',zone,aircraft:type,defect,priority,tail:tail.trim()};
   history.set(call.number,call);
   if(remark){call.remarkId=remark.id;remark.call=call.number}
   if(body.scheduled){call.scheduled=body.scheduled;db.record('aircraft-schedule',user.id,call,{tail,scheduled:call.scheduled})}
   call.ata=Number(defects[defect][1].split(' ')[1]);call.kit=!!body.kit;
   call.description=defects[defect].join(' · ');call.source=['Экипаж','Сотрудник','MCC/ЦПУ'].includes(body.source)?body.source:'Экипаж';
   if(remark)call.source='Сотрудник';
   call.melHistory=call.tail?[...history.values()].filter(old=>old.number!==call.number&&old.tail===call.tail&&old.mel).map(old=>({number:old.number,mel:old.mel,until:old.until})):[];
   pending.set(call.number,call);log('registered',user.id,call,{...call});return send(call);
 }
 if(path==='/api/assign' && post && user.role==='dispatcher'){
   const p=points.get(body.id);
   if(!p || Date.now()-p.time>60000 || p.accuracy>50 || jobs.has(body.id) || p.time!==body.time)fail(409,'Состояние изменилось, обновите расчёт');
   if(!zones.some(z=>z.properties.id===body.zone))fail(400,'Неизвестная зона');
   const call=pending.get(body.number);
   if(!call || call.zone!==body.zone)fail(409,'Выберите открытый вызов');
   const candidate=rank(call)[0];
   if(!candidate?.route||candidate.id!==body.id)fail(409,'Изменилась рекомендация по очереди, обновите расчёт');
   call.vehicle=candidate.route.vehicle;call.store=candidate.route.store;call.firstEta=Date.now()+candidate.route.minutes*60000;
   call.status='assigned';call.assignedAt=Date.now();jobs.set(body.id,call);pending.delete(call.number);log('assigned',user.id,call,{engineer:body.id,route:candidate.route.mode,forecast:call.firstEta});return send({});
 }
 if(path.startsWith('/api/') || (path==='/scenarios' && user.role!=='dispatcher'))fail(403,'Доступ ограничен');
 const file=files.get(path);
 if(!file || post)fail(404,'Страница не найдена');
 res.setHeader('Content-Type',file[1]+'; charset=utf-8');
 res.end(readFileSync(new URL(file[0],import.meta.url)));
}
const handler=(req,res)=>handle(req,res).catch(e=>{res.statusCode=e.status||500;if(req.url?.split('?')[0]==='/api/v1/track'&&[400,413,415].includes(res.statusCode))db.record('input-rejected','Источник',null,{status:res.statusCode,reason:e.message});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.status?e.message:'Ошибка сервера'}));});
const server=tls?https.createServer({key:readFileSync(process.env.TLS_KEY),cert:readFileSync(process.env.TLS_CERT)},handler):http.createServer(handler);
server.on('error',error=>{
  console.error(error.code==='EADDRINUSE'?'Адрес уже занят. Если сайт уже открыт, используйте коды работающей смены.':error.message);
  process.exitCode=1;
});
server.listen(port,host,()=>{
  if(!process.env.RENDER)for(const [code,account] of accounts)console.log(account.id+' — '+code);
  console.log('Перрон-15 · '+(tls?'https':'http')+'://'+host+':'+server.address().port);
});

