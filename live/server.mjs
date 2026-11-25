import http from 'node:http';
import https from 'node:https';
import {readFileSync,mkdirSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {aircraft,defects,priorities} from './calls.mjs';
import {track} from './track.mjs';
import {journal} from './journal.mjs';
import {homedir,tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {officialLineup,seedPositions} from './lineup.mjs';
const training=process.env.SHIFT_PROFILE==='training';
const agents=training?JSON.parse(readFileSync(new URL('./agents.json',import.meta.url))):officialLineup();
const feedKey=process.env.TRACK_KEY || randomBytes(24).toString('hex');
import {transition,insideZone} from './lifecycle.mjs';
import {xy,setOrigin,center} from './route.js';
import {planner} from './planning.mjs';
import {forecast,comparePair,deadlineOf} from './deadlines.mjs';
const layer=n=>JSON.parse(readFileSync(new URL('./data/'+n+'.geojson',import.meta.url)));
const zones=layer('service_zones').features;
setOrigin(layer('airport_boundaries'));
const roads=layer('roads');
const objects=layer('objects').features;
const extraAccounts=new Map();
const digest=s=>createHash('sha256').update(s).digest('hex');
const remarks=new Map();
const atlb=new Map();
let feedUntil=0;
const history=new Map();
const offerMs=Number(process.env.OFFER_TIMEOUT_MS)||60000;
function deadlineBreach(call,now){
 if(!(call.firstArrivalAt<=deadlineOf(call))&&!call.breachAt&&now>deadlineOf(call)){
  call.breachAt=now;log('deadline-breach','Система',call,{deadline:deadlineOf(call),observedAt:now,arrivalConfirmed:!!call.arrivedAt});
 }
}
function stopPhone(user){
 const p=points.get(user.id);
 if(agents.some(a=>a.obj===user.obj&&a.initial)&&p&&p.source!=='phone')return;
 if(user.obj==='AT-0001'&&p?.source==='phone'){
  p.stopped=true;db.record('phone-stop',user.id,null,{obj:user.obj});
 }else points.delete(user.id);
}
function onPosition(agent,point){
 db.record('gps-fix',agent.id,jobs.get(agent.id),{obj:agent.obj,lat:point.lat,lon:point.lon,accuracy:point.accuracy,fixAt:point.time,source:point.source});
 if(agent.kind==='vehicle'||agent.kind==='aircraft')for(const [id,c] of jobs){
  if(c.arrivedAt||(agent.kind==='aircraft'&&c.tail!==agent.obj))continue;
  if(c.forceVehicle&&!c.vehicle&&!c.disembarked){const option=routing.plan(id,c,undefined,true);c.vehicle=option?.vehicle;c.store=option?.store}
  const r=routing.plan(id,c);db.record('route-update',id,c,{trigger:agent.obj,forecast:r?Date.now()+r.minutes*60000:null,mode:r?.mode});
 }
 const call=jobs.get(agent.id);
 if(call?.vehicle&&!call.boarded&&call.status==='enroute'){
  const v=points.get(call.vehicle);
  if(v&&(v.source==='start'||(Date.now()-v.time<=60000&&Math.abs(v.time-point.time)<=60000))&&v.accuracy<=30&&point.accuracy<=30){
   const [x,y]=xy([point.lon,point.lat]),[u,w]=xy([v.lon,v.lat]);
   if(Math.hypot(x-u,y-w)<=12){call.boarded=true;log('vehicle-pickup',agent.id,call,{vehicle:call.vehicle})}
  }
 }
 if(call?.boarded&&!call.disembarked&&call.status==='enroute'&&(!call.kit||call.kitCollected)){
  const drop=routing.plan(agent.id,call)?.dropoff,here=xy([point.lon,point.lat]);
  if(drop&&Math.hypot(here[0]-drop[0],here[1]-drop[1])<=8){call.disembarked=true;log('vehicle-dropoff',agent.id,call,{vehicle:call.vehicle})}
 }
 if(call&&!call.arrivedAt){const r=routing.plan(agent.id,call),forecast=r?point.time+r.minutes*60000:null;
  db.record('route-update',agent.id,call,{forecast,mode:r?.mode,meters:r?.meters});
  if(!forecast||forecast>deadlineOf(call))db.record('risk','Диспетчер',call,{forecast,deadline:deadlineOf(call)});
 }
 if(call?.store&&(!call.forceVehicle||call.boarded)&&!call.kitCollected&&call.status==='enroute'&&point.time>=call.acceptedAt&&Date.now()-point.time<=60000&&point.accuracy<=50){const pos=xy([point.lon,point.lat]);if(objects.some(f=>{const mid=center(f);return Math.hypot(mid[0]-call.store[0],mid[1]-call.store[1])<0.05&&insideZone([point.lon,point.lat],f)})){call.kitCollected=true;log('kit-collected',agent.id,call)}}
 const zoneId=call?.status==='enroute'?routing.destination(call).zone:null;
 const arrivalZone=zoneId!=null&&zones.find(z=>z.properties.id===zoneId);
 if(arrivalZone&&(!call.forceVehicle||call.boarded)&&(!call.kit||call.kitCollected)&&point.time>=call.acceptedAt&&Date.now()-point.time<=60000&&point.accuracy<=50&&insideZone([point.lon,point.lat],arrivalZone)){
   transition(call,'arrive',point.time);
   if(!call.firstArrivalAt){
    call.firstArrivalAt=point.time;log('arrival',agent.id,call,{arrivedAt:point.time,inLimit:call.inLimit,standardInLimit:point.time<=call.createdAt+900000,deadline:deadlineOf(call),elapsedSeconds:(point.time-call.createdAt)/1000});
   }else{
    call.inLimit=call.firstArrivalAt<=deadlineOf(call);
    log('return-arrival',agent.id,call,{arrivedAt:point.time,firstArrivalAt:call.firstArrivalAt});
   }
   if(!call.inLimit)deadlineBreach(call,point.time);
   else if(call.breachAt){delete call.breachAt;log('deadline-confirmed-on-time',agent.id,call,{fixAt:point.time})}
 }
}
function activeView(id){
 const c=jobs.get(id),p=points.get(id);
 if(!c)return null;
 const route=routing.plan(id,c);
 const now=Date.now(),eta=route?forecast(c,route.minutes,now).eta:null;
 const risk=!c.firstArrivalAt&&!c.arrivedAt&&(!eta||eta>deadlineOf(c));
 const replacement=risk?candidates(c,now).find(x=>x.route&&x.id!==id&&!jobs.has(x.id)):null;
 const alternate=replacement?{id:replacement.id,minutes:replacement.route.minutes,busyUntil:replacement.busyUntil,...replacement.forecast}:null;
 const aircraftNear=p&&agents.filter(a=>a.kind==='aircraft').find(a=>{
  const q=points.get(a.id);if(!q||Date.now()-q.time>60000||Date.now()-p.time>60000)return false;
  const [x,y]=xy([q.lon,q.lat]),[u,v]=xy([p.lon,p.lat]);return Math.hypot(x-u,y-v)<75;
 });
 if((aircraftNear?.id||null)!==(c.nearbyAircraft||null)){c.nearbyAircraft=aircraftNear?.id||null;log('aircraft-proximity',id,c,{aircraft:c.nearbyAircraft,thresholdMeters:75})}
 const riskKey=risk?JSON.stringify([alternate?.id,alternate?.inTime,deadlineOf(c)]):'';
 if(riskKey!==(c.lastRiskKey||'')){c.lastRiskKey=riskKey;log('forecast-risk',id,c,{risk,eta,deadline:deadlineOf(c),alternate})}
 const destination=routing.destination(c);
 const atlbHistory=[...atlb.values()].filter(r=>r.tail===c.tail?.toUpperCase()&&r.ata===c.ata);
 return {...c,routeReason:route?'':routing.unavailable(id,c),atlbHistory,route,point:p,eta,risk,alternate,arrivalZone:destination.zone,targetSource:destination.source,aircraftNear:aircraftNear?.id};
}

const accounts = new Map();
const sessions = new Map();
const beacons=new Map();
const points = new Map();
const jobs = new Map();
const routing=planner(roads,zones,objects,agents,points,jobs);
function candidates(c,now,reservedVehicle){
 return agents.filter(a=>a.kind==='engineer').map(a=>{
   const p=points.get(a.id),job=jobs.get(a.id);
   const previous=c.offers?.findLast(o=>o.engineer===a.id);
   const declined=previous?.outcome==='rejected'?'Отклонил вызов':previous?.outcome==='timeout'&&now-previous.endedAt<120000?'Не ответил на вызов':'';
   const finishing=job?.status==='working'&&a.availabilityJob===job.number&&a.busyUntil>now;
   const reason=job&&!finishing?'Занят · '+job.status:declined||(!a.ata.includes(c.ata)?'Нет допуска ATA '+c.ata:a.models&&!a.models.includes(c.aircraft)?'Нет допуска на '+c.aircraft:!p||p.stopped||(p.source==='start'&&a.obj==='AT-0001')?'Ожидаем GPS телефона':p.source!=='start'&&!(a.initial&&p.source==='feed')&&now-p.time>60000?'Координаты устарели':p.accuracy>50?'Низкая точность GPS':'');
   const route=reason?null:routing.plan(a.id,c,reservedVehicle);
   const busyUntil=a.busyUntil||0,waitMinutes=Math.max(0,busyUntil-now)/60000;
   return {id:a.id,time:p?.time,route,busyUntil,waitMinutes,forecast:route?forecast(c,route.minutes+waitMinutes,now):null,reason:reason||(!route?routing.unavailable(a.id,c):'')};
 }).sort((a,b)=>(a.forecast?.eta??Infinity)-(b.forecast?.eta??Infinity));
}
function queueOrder(a,b){return Number(!!b.aog)-Number(!!a.aog)||a.priority.localeCompare(b.priority)||a.createdAt-b.createdAt||a.number-b.number}
function rank(c){
 const started=performance.now(),now=Date.now(),result=candidates(c,now);
 const other=[...pending.values()].filter(j=>j.number!==c.number&&(j.aog||j.priority==='A')).sort(queueOrder)[0];
 if(other&&!c.offers?.length){
  const baseline=candidates(other,now),byVehicle=new Map([[undefined,baseline]]);
  for(const row of result.filter(row=>row.route)){
   const vehicle=row.route.vehicle;
   if(!byVehicle.has(vehicle))byVehicle.set(vehicle,candidates(other,now,vehicle));
   const next=byVehicle.get(vehicle).find(x=>x.route&&x.id!==row.id);
   row.impact={number:other.number,baseline:baseline[0]?.forecast||null,engineer:next?.id,remaining:next?.forecast||null};
  }
  result.sort((a,b)=>a.route&&b.route?comparePair(a,b):Number(!!b.route)-Number(!!a.route));
 }
 const signature=JSON.stringify(result.map(r=>[r.id,r.time,r.reason,r.route?.minutes,r.route?.mode,r.forecast?.inTime,r.impact?.number,r.impact?.engineer,r.impact?.remaining?.inTime,r.busyUntil]));
 if(c.rankSignature!==signature){c.rankSignature=signature;log('candidates','Система',c,{durationMs:performance.now()-started,candidates:result.map(r=>({id:r.id,reason:r.reason,mode:r.route?.mode,minutes:r.route?.minutes,busyUntil:r.busyUntil,forecast:r.forecast,impact:r.impact}))})}
 return result;
}
function clearWorkEstimate(engineer,number){
 const agent=agents.find(a=>a.id===engineer);
 if(agent?.availabilityJob===number){agent.busyUntil=0;agent.availabilityJob=null}
}
function releaseOffer(call,engineer,outcome,now,requestId){
 const offer=call.offers?.at(-1);
 if(offer){offer.outcome=outcome;offer.endedAt=now}
 jobs.delete(engineer);call.status='pending';pending.set(call.number,call);
 delete call.vehicle;delete call.store;delete call.boarded;delete call.disembarked;delete call.replyBy;
 log('offer-'+outcome,engineer,call,{at:now,requestId});
}
function processQueue(manual){
 const now=Date.now();
 for(const [id,c] of jobs){
  if(!c.arrivedAt)deadlineBreach(c,now);
  if(c.status==='assigned'&&now>=(c.replyBy??c.assignedAt+offerMs))releaseOffer(c,id,'timeout',now);
 }
 for(const c of [...pending.values()].sort(queueOrder)){
  deadlineBreach(c,now);
  const ranking=rank(c);
  const explicit=manual?.number===c.number;
  const pick=explicit?ranking.find(r=>r.id===manual.engineer):ranking[0];
  const risk=!c.firstArrivalAt&&(!pick?.forecast||!pick.forecast.inTime);
  if(risk!==!!c.queueRisk||(risk&&c.queueRiskDeadline!==deadlineOf(c))){
   c.queueRisk=risk;c.queueRiskDeadline=deadlineOf(c);
   log('forecast-risk','Диспетчер',c,{stage:'queue',risk,deadline:deadlineOf(c),eta:pick?.forecast?.eta??null,engineer:pick?.id,reason:pick?.reason});
  }
  if(c.manualFirst&&!c.offers?.length&&!explicit)continue;
  if(!pick?.route||pick.busyUntil>now||jobs.has(pick.id))continue;
  c.status='assigned';c.assignedAt=now;c.replyBy=now+offerMs;
  c.vehicle=pick.route.vehicle;c.store=pick.route.store;c.firstEta??=pick.forecast.eta;
  const comparison=ranking.map(r=>({id:r.id,reason:r.reason,ata:c.ata,qualified:!!r.route,mode:r.route?.mode,alternatives:r.route?.alternatives,meters:r.route?.meters,waitMinutes:r.waitMinutes,forecast:r.forecast,impact:r.impact}));
  (c.offers??=[]).push({comparison,engineer:pick.id,at:now,replyBy:c.replyBy,outcome:'offered'});
  jobs.set(pick.id,c);pending.delete(c.number);
  log('assigned',explicit?manual.actor:'Система',c,{engineer:pick.id,route:pick.route.mode,meters:pick.route.meters,minutes:pick.route.minutes,alternatives:pick.route.alternatives,forecast:pick.forecast.eta,replyBy:c.replyBy,target:routing.destination(c).source});
 }
}
const pending = new Map();
let nextCall = 1;
const dbFile=process.env.STATE_DB||join(process.env.RENDER?tmpdir():homedir(),'.perron-15','shift.sqlite');
mkdirSync(dirname(dbFile),{recursive:true});const db=journal(dbFile);
const saved=db.restore();
if(saved){
 for(const row of saved.atlb||[])atlb.set(row.ref,row);
 if(saved.agents){
  const missing=agents.filter(a=>!training&&!saved.agents.some(x=>x.obj===a.obj)&&!saved.lineupVersion);
  agents.splice(0,agents.length,...saved.agents,...missing);
 }
 for(const [key,a] of saved.extraAccounts||[])extraAccounts.set(key,a);
 for(const r of saved.remarks||[])remarks.set(r.id,r);
 for(const c of saved.calls)history.set(c.number,c);
 for(const n of saved.pending)pending.set(n,history.get(n));
 for(const [id,n] of saved.jobs){
  const call=history.get(n);
  if(call.status==='assigned'&&!call.offers){
   call.assignedAt??=Date.now();call.replyBy=call.assignedAt+offerMs;
   call.offers=[{engineer:id,at:call.assignedAt,replyBy:call.replyBy,outcome:'offered'}];
  }
  jobs.set(id,call);
 }
 nextCall=Math.max(0,...history.keys())+1;
 routing.close(saved.closed||[]);
 for(const [k,v] of Object.entries(saved.defects||{}))defects[k]=v;
}
if(!training){
 for(const a of agents.filter(a=>a.initial)){
  const fix=db.lastFix(a.obj);
  if(fix)points.set(a.id,{obj:a.obj,lon:fix.lon,lat:fix.lat,time:fix.fixAt,accuracy:fix.accuracy,source:fix.source||'feed',stopped:fix.stopped});
 }
 seedPositions(agents,points);
}
function log(kind,actor,c,detail={}){
 if(c?.testDeadline||c?.forceVehicle)detail={...detail,test:true};
 db.record(kind,actor,c,detail,{calls:[...history.values()],pending:[...pending.keys()],jobs:[...jobs].map(([id,j])=>[id,j.number]),lineupVersion:training?0:1,closed:routing.closed,defects,agents,extraAccounts:[...extraAccounts],atlb:[...atlb.values()],remarks:[...remarks.values()]});
}
const backgroundKeys=new Map();
const attempts = new Map();
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const port = Number(process.env.PORT || (process.env.RENDER?10000:8175));
const host = process.env.HOST || (process.env.RENDER?'0.0.0.0':'127.0.0.1');
if (!tls && !['127.0.0.1','localhost','::1'].includes(host) && process.env.TRUST_HTTPS_PROXY !== 'yes') {
  throw Error('Для сети настройте HTTPS (TLS_CERT и TLS_KEY) или защищённый обратный прокси.');
}
for(const [id,role,variable] of [['Диспетчер','dispatcher','DISPATCH_CODE'],[training?'Инженер 1':'AT-0001','engineer','ENGINEER_ONE_CODE'],[training?'Инженер 2':'AT-0002','engineer','ENGINEER_TWO_CODE']]){
  const obj=agents.find(a=>a.id===id)?.obj;
  if(role==='engineer'&&(!obj||[...extraAccounts.values()].some(account=>account.obj===obj)))continue;
  const code=process.env[variable]||randomBytes(8).toString('hex');
  accounts.set(code,{id,role,obj,...(role==='dispatcher'?{supervisor:true}:{})});
}
function engineerCredential(agent){
 const code=randomBytes(8).toString('hex');
 return {code,key:digest(code),account:{id:agent.id,obj:agent.obj,membershipId:agent.membershipId,role:'engineer'}};
}
function revokeEngineerAccess(obj){
  for(const [key,account] of accounts)if(account.role==='engineer'&&account.obj===obj)accounts.delete(key);
  for(const [key,entry] of sessions)if(entry.user.obj===obj)sessions.delete(key);
  backgroundKeys.delete(obj);
}
const files = new Map(Object.entries({
  '/':['index.html','text/html'], '/ui.js':['ui.js','text/javascript'],
  '/outbox.js':['outbox.js','text/javascript'], '/catalog.json':['catalog.json','application/json'],
  '/roster.js':['roster.js','text/javascript'],
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
 const simulatorRequest=path==='/api/v1/track'&&req.headers.origin==='https://itsim.geolaba.net';
 if(simulatorRequest){
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
  if(req.method==='OPTIONS'){
   res.writeHead(204,{'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});return res.end();
  }
 }
 const post = req.method === 'POST';
 if (!post && req.method !== 'GET') fail(405,'Метод недоступен');
 const token = /(?:^|; *)shift=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
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
 const session = sessions.get(token);
 const user = session?.until > Date.now() ? session.user : null;
 if(path==='/api/login' && post){
   const ip=req.socket.remoteAddress;
   const recent=(attempts.get(ip)||[]).filter(t=>Date.now()-t<60000);
   if(recent.length>=12)fail(429,'Попробуйте через минуту');
   const account=typeof body.code==='string'&&(accounts.get(body.code)||extraAccounts.get(digest(body.code)));
   if(!account || (account.role==='mcc'?'dispatcher':account.role)!==body.role){attempts.set(ip,[...recent,Date.now()]);fail(401,'Проверьте роль и код смены');}
   const sid=randomBytes(32).toString('hex');
   sessions.set(sid,{user:account,until:Date.now()+12*3600000});
   res.setHeader('Set-Cookie','shift='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(tls || process.env.TRUST_HTTPS_PROXY==='yes'?'; Secure':''));
   return send({...account,shiftId:db.shiftId});
 }
 if(path==='/api/staff-code'&&post&&user?.supervisor){
  if(!['dispatcher','mcc'].includes(body.role))fail(400,'Укажите рабочее место');
  const code=randomBytes(8).toString('hex'),role=body.role;
  const worker={role,id:(role==='mcc'?'MCC':'Диспетчер')+' '+randomBytes(3).toString('hex')};
  extraAccounts.set(digest(code),worker);log('staff-code-issued',user.id,null,{id:worker.id,role});return send({code,id:worker.id});
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
   if(stamp>=Date.now()-60000)track({obj,lat:body.lat,lon:body.lon,acc:body.acc,t:new Date(stamp).toISOString()},agents,points,onPosition,Date.now(),'phone');
  }
  return send([]);
 }
 if(path==='/api/me' && !post)return send(user?{...user,shiftId:db.shiftId}:null);
 if(path==='/api/track-key' && !post && user?.role==='dispatcher')return send({key:feedKey});
 if(path==='/api/beacon'&&post&&user?.role==='dispatcher'){
  const a=agents.find(a=>a.obj===body.obj&&a.kind==='vehicle');if(!a)fail(400,'Укажите ID транспорта');
  const key=randomBytes(24).toString('hex');beacons.set(key,{obj:a.obj,until:Date.now()+12*3600000});return send({key,obj:a.obj});
 }
 if(path==='/api/competition-feed'&&post&&user?.role==='dispatcher'){feedUntil=body.enable?Date.now()+3600000:0;log('competition-feed',user.id,null,{feedUntil});return send({feedUntil})}
 if(path==='/api/v1/track' && post){
  const beacon=beacons.get(req.headers.authorization?.slice(7));
  const external=req.headers.authorization==='Bearer '+feedKey||(!user&&(simulatorRequest||Date.now()<feedUntil))||(beacon?.until>Date.now()&&body.obj===beacon.obj&&!Object.hasOwn(body,'points'));
  if(!external&&!user)fail(401,'Нужен ключ источника');
  if(!external&&user.role==='mcc')fail(403,'Рабочее место MCC не передаёт GPS');
  if(!external&&user.role==='engineer'&&(body.obj!==user.obj||Object.hasOwn(body,'points')))fail(403,'Доступ только к своей позиции');
  try{const result=track(body,agents,points,onPosition,Date.now(),!external&&user?.role==='engineer'?'phone':'feed');for(const r of [].concat(result))if(!r.applied)db.record('track-not-applied','Источник',null,r);return send(result)}
  catch(e){throw e}
 }
 if(path==='/api/agents'&&!post&&user)return send(agents.filter(a=>user.role==='dispatcher'||a.id===user.id||a.kind!=='engineer').map(a=>({...a,point:points.get(a.id)})));
 if(path==='/api/engineer-code'&&post&&user?.role==='dispatcher'){
  const agent=agents.find(a=>a.obj===body.obj&&a.kind==='engineer');
  if(!agent)fail(404,'Инженер не найден');
  const issued=engineerCredential(agent);
  const old=[...extraAccounts].filter(([,account])=>account.obj===agent.obj);
  for(const [key] of old)extraAccounts.delete(key);
  extraAccounts.set(issued.key,issued.account);
  try{log('engineer-code-issued',user.id,null,{obj:agent.obj})}
  catch(error){
   extraAccounts.delete(issued.key);
   for(const [key,account] of old)extraAccounts.set(key,account);
   throw error;
  }
  revokeEngineerAccess(agent.obj);
  return send({obj:agent.obj,code:issued.code});
 }
 if(path==='/api/remove-engineer'&&post&&user?.role==='dispatcher'){
  const index=agents.findIndex(a=>a.kind==='engineer'&&a.obj===body.obj);
  if(index<0)fail(404,'Инженера уже нет в смене');
  const agent=agents[index];
  if(body.id!==agent.id||body.membershipId!==(agent.membershipId??null))fail(409,'Состав смены изменился. Выберите инженера заново.');
  const job=jobs.get(agent.id);
  if(job)fail(409,'У инженера заявка № '+job.number+'. Сначала завершите её или верните в очередь.');
  const credentials=[...extraAccounts].filter(([,account])=>account.obj===agent.obj);
  agents.splice(index,1);
  for(const [key] of credentials)extraAccounts.delete(key);
  try{log('engineer-removed',user.id,null,{obj:agent.obj,id:agent.id})}
  catch(error){
   agents.splice(index,0,agent);
   for(const [key,account] of credentials)extraAccounts.set(key,account);
   throw error;
  }
  revokeEngineerAccess(agent.obj);
  points.delete(agent.id);
  return send({obj:agent.obj});
 }
 if(path==='/api/roster'&&post&&user?.role==='dispatcher'){
  const {obj,kind,ata}=body;
  if(typeof obj!=='string'||!/^[-\w]{1,32}$/.test(obj)||!['engineer','vehicle','aircraft'].includes(kind)||!Array.isArray(ata)||ata.some(n=>!Number.isInteger(n)||n<1||n>99))fail(400,'Проверьте идентификатор, тип и допуски');
  let a=agents.find(a=>a.obj===obj);if(a&&a.kind!==kind)fail(409,'Тип существующего объекта изменить нельзя');
  if(body.createOnly&&a)fail(409,'Этот идентификатор уже занят');
  if(body.previous){
   const same=(left,right)=>Array.isArray(right)&&JSON.stringify([...left].sort())===JSON.stringify([...right].sort());
   if(!a||!same(a.ata||[],body.previous.ata)||!same(a.models??aircraft,body.previous.models))fail(409,'Другой диспетчер изменил допуски. Выберите сотрудника заново и проверьте изменения.');
  }
  if(body.models!==undefined&&(!Array.isArray(body.models)||body.models.some(m=>!aircraft.includes(m))))fail(400,'Проверьте типы ВС');
  if(!a){
   const name=body.name===undefined?obj:body.name;
   if(typeof name!=='string'||!name.trim()||name.trim().length>64)fail(400,'Введите имя до 64 символов');
   const id=name.trim();
   if(id==='Диспетчер'||agents.some(agent=>agent.id===id))fail(409,'Участник с таким именем уже есть');
   a={id,obj,kind,ata};if(kind==='engineer')a.membershipId=randomBytes(12).toString('hex');if(body.models)a.models=body.models;
   const issued=kind==='engineer'?engineerCredential(a):null;
   agents.push(a);
   if(issued)extraAccounts.set(issued.key,issued.account);
   try{log('roster',user.id,null,{obj,kind,ata})}
   catch(error){agents.pop();if(issued)extraAccounts.delete(issued.key);throw error}
   return send({obj,code:issued?.code??null});
  }
  if(body.models)a.models=body.models;
  a.ata=ata;log('roster',user.id,null,{obj,kind,ata});return send({obj,code:null});
 }
 if(path==='/api/roads'&&user&&(!post||user.role==='dispatcher')){
  if(post){if(!Array.isArray(body.ids)||body.ids.some(i=>!roads.features.some(f=>f.properties.id===i)))fail(400,'Проверьте ID рёбер');routing.close(body.ids)}
  if(post){
   log('road-closures',user.id,null,{ids:routing.closed});
   for(const [id,c] of jobs)if(!c.arrivedAt){const job=activeView(id);db.record('route-update',id,c,{trigger:'road-closures',forecast:job.eta,meters:job.route?.meters})}
  }
  return send(routing.closed);
 }
 if(path==='/api/rank'&&user?.role==='dispatcher'&&!post){
  const c=pending.get(Number(new URL(req.url,'http://localhost').searchParams.get('number')));
  return send(c?rank(c):[]);
 }
 if(path.startsWith('/api/') || path.startsWith('/data/') || path==='/scenarios'){
   if(!user)fail(401,'Войдите в смену');
 }
 if(path==='/api/logout' && post){sessions.delete(token);if(backgroundKeys.get(user.obj)?.session===token)backgroundKeys.delete(user.obj);if(user.role==='engineer')stopPhone(user);res.setHeader('Set-Cookie','shift=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');return send({});}
 if(path==='/api/point' && post && user.role==='engineer'){
   if(body.stop){stopPhone(user);return send({});}
   const {lat,lon,accuracy,time}=body;
   if(![lat,lon,accuracy,time].every(Number.isFinite)||Math.abs(lat)>90||Math.abs(lon)>180||accuracy<0||Date.now()-time>60000||time>Date.now()+5000)fail(400,'Координаты устарели или некорректны');
   track({obj:user.obj,lat,lon,acc:accuracy,t:new Date(time).toISOString()},agents,points,onPosition,Date.now(),'phone');
   return send({});
 }
 if(path==='/api/log.csv'&&!post&&user.role==='dispatcher'){res.setHeader('Content-Type','text/csv;charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="perron-events.csv"');return res.end(db.csv())}
 if(path==='/api/team' && !post && user.role==='dispatcher')return send(agents.filter(a=>a.kind==='engineer').map(a=>({id:a.id,point:points.get(a.id),job:activeView(a.id)})));
 if(path==='/api/metrics'&&!post&&user.role==='dispatcher')return send(db.metrics());
 const receipt=body.requestId;
 if(receipt!==undefined&&user?.role==='engineer'&&post){
  if(typeof receipt!=='string'||!/^[-a-z0-9]{36}$/i.test(receipt))fail(400,'Некорректный номер действия');
  if(body.shiftId!==db.shiftId)fail(409,'Смена изменилась');
  if(db.received(user.id,receipt))return send({delivered:true});
 }
 if(path==='/api/mcc'&&user.role==='mcc'){
  if(!post)return send([...remarks.values()].filter(r=>!r.call&&!r.reviewedAt));
  const r=remarks.get(body.id);
  if(!r||r.reviewedAt||r.call)fail(409,'Замечание уже обработано');
  r.reviewedAt=Date.now();r.reviewer=user.id;log('mcc-reviewed',user.id,null,{remarkId:r.id,note:r.note});return send(r);
 }
 if(path==='/api/remarks'&&['engineer','mcc'].includes(user.role)&&post){
  const note=typeof body.note==='string'?body.note.trim():'';
  if(!note||note.length>300)fail(400,'Введите до 300 символов');
  const r={id:randomBytes(6).toString('hex'),author:user.id,requiresReview:user.role==='mcc',source:user.role==='mcc'&&body.source==='Экипаж'?'Экипаж':'Сотрудник',note,at:Date.now()};remarks.set(r.id,r);log('remark',user.id,null,{...r,requestId:receipt});return send(r);
 }
 if(path==='/api/remarks'&&user.role==='dispatcher'&&!post)return send([...remarks.values()].filter(r=>!r.call&&(!r.requiresReview||r.reviewedAt)));
 if(path==='/api/catalog'&&!post)return send(defects);
 if(path==='/api/availability'&&post&&user.role==='engineer'){
  const minutes=body.minutes;
  if(!Number.isInteger(minutes)||minutes<0||minutes>1440)fail(400,'Введите от 0 до 1440 минут');
  const agent=agents.find(a=>a.obj===user.obj&&a.kind==='engineer');
  const statedAt=Number.isFinite(body.statedAt)?Math.min(Date.now(),body.statedAt):Date.now();
  agent.busyUntil=minutes?statedAt+minutes*60000:0;
  const call=jobs.get(agent.id);
  agent.availabilityJob=minutes&&call?.status==='working'?call.number:null;
  if(agent.busyUntil>Date.now()&&call?.status==='assigned')releaseOffer(call,agent.id,'busy',Date.now());
  log('availability',agent.id,null,{requestId:receipt,busyUntil:agent.busyUntil,minutes});
  processQueue();return send({busyUntil:agent.busyUntil});
 }
 if(path==='/api/assign'&&post&&user.role==='dispatcher'){
  const c=pending.get(body.number);
  if(!c)fail(409,'Назначение уже изменилось');
  processQueue({number:c.number,engineer:body.engineer,actor:user.id});
  if(jobs.get(body.engineer)!==c)fail(409,'Инженер сейчас недоступен');
  return send({number:c.number});
 }
 if(path==='/api/seed'&&post&&user.role==='dispatcher'){
  const added=seedPositions(agents,points);log('lineup-loaded',user.id,null,{added});return send({added});
 }
 if(path==='/api/vehicle-participation'&&post&&user.role==='dispatcher'){
  const a=agents.find(a=>a.obj==='vehicle-03');
  if(!a||typeof body.enabled!=='boolean')fail(400,'Проверьте участие vehicle-03');
  a.enabled=body.enabled;
  for(const [id,c] of jobs)if(c.vehicle===a.id&&!a.enabled){
   delete c.boarded;delete c.disembarked;delete c.vehicle;
   const r=routing.plan(id,c,undefined,true);c.vehicle=r?.vehicle;c.store=r?.store;
   log('route-update',id,c,{trigger:'vehicle-disabled',vehicle:c.vehicle,forecast:r?Date.now()+r.minutes*60000:null});
  }
  if(a.enabled)for(const [id,c] of jobs)if(c.forceVehicle&&!c.vehicle&&!c.arrivedAt){
   const r=routing.plan(id,c,undefined,true);c.vehicle=r?.vehicle;c.store=r?.store;
  }
  log('vehicle-participation',user.id,null,{obj:a.obj,enabled:a.enabled});processQueue();return send({enabled:a.enabled});
 }
 if(path==='/api/trial'&&post&&user.role==='dispatcher'){
  const c=history.get(body.number),now=Date.now();
  if(!c||c.arrivedAt||!['assigned','pending','enroute'].includes(c.status))fail(409,'Нужна действующая заявка до прибытия');
  if(body.remainingSeconds!==undefined){
   if(!Number.isInteger(body.remainingSeconds)||body.remainingSeconds<1||body.remainingSeconds>900||now+body.remainingSeconds*1000>=deadlineOf(c))fail(400,'Укажите меньший остаток срока в секундах');
   c.testDeadline=now+body.remainingSeconds*1000;
   log('test-deadline',user.id,c,{test:true,deadline:c.testDeadline,originalDeadline:c.createdAt+900000});
  }else if(typeof body.forceVehicle==='boolean'){
   c.forceVehicle=body.forceVehicle;
   const assigned=[...jobs].find(([,j])=>j===c);
   if(assigned){const r=routing.plan(assigned[0],c,undefined,true);c.vehicle=r?.vehicle;c.store=r?.store}
   log('test-transport',user.id,c,{test:true,enabled:c.forceVehicle,vehicle:c.vehicle});
  }else fail(400,'Неизвестное действие');
  processQueue();for(const [id,j] of jobs)if(j===c)activeView(id);
  return send({number:c.number,deadline:deadlineOf(c),forceVehicle:!!c.forceVehicle});
 }
 if(path==='/api/dispatch'&&!post&&user.role==='dispatcher'){
  return send([...history.values()].sort((a,b)=>b.number-a.number).map(c=>{
   const destination=routing.destination(c);
   const {number,createdAt,zone,aircraft,tail,description,defect,priority,aog,mel,status,offers,arrivedAt,inLimit,breachAt}=c;
   return {forceVehicle:!!c.forceVehicle,testDeadline:c.testDeadline,queueRisk:c.queueRisk,manualFirst:c.manualFirst,number,createdAt,zone,aircraft,tail,description,defect,priority,aog,mel,status,offers,arrivedAt,inLimit,breachAt,targetSource:destination.source,arrivalZone:destination.zone};
  }));
 }
 if(path==='/api/job' && !post && user.role==='engineer')return send(activeView(user.id));
 if(path==='/api/tool'&&post&&user.role==='engineer'){
  const c=jobs.get(user.id);if(!c||c.number!==body.number||!c.kit||typeof body.collected!=='boolean')fail(409,'Проверьте задание и комплект');
  c.kitCollected=body.collected;
  if(!c.kitCollected)c.store=routing.plan(user.id,c)?.store;
  log('kit-status',user.id,c,{requestId:receipt,collected:c.kitCollected});return send(c);
 }
 if(path==='/api/atlb'&&post&&user.role==='dispatcher'){
  const rows=body.records;
  if(!Array.isArray(rows)||!rows.length||rows.length>500)fail(400,'Нужен массив записей ATLB');
  const seen=new Set();
  for(const r of rows){
   if(!r||typeof r.ref!=='string'||!r.ref.trim()||r.ref.length>80||typeof r.tail!=='string'||!r.tail.trim()||r.tail.length>24||!Number.isInteger(r.ata)||r.ata<1||r.ata>99||!['A','B','C','D'].includes(r.mel)||!Number.isFinite(Date.parse(r.until))||typeof r.description!=='string'||!r.description.trim()||r.description.length>300)fail(400,'Проверьте поля записи ATLB');
   if(seen.has(r.ref)||atlb.has(r.ref))fail(409,'Номер записи ATLB уже есть');seen.add(r.ref);
  }
  for(const {ref,tail,ata,mel,until,description} of rows)atlb.set(ref,{ref,tail:tail.trim().toUpperCase(),ata,mel,until,description});
  log('atlb-imported',user.id,null,{refs:[...seen]});return send({imported:rows.length});
 }
 if(path==='/api/decision'&&post&&user.role==='engineer'){
  const c=jobs.get(user.id);if(!c||c.number!==body.number||c.status!=='working')fail(409,'Решение доступно при выполнении работ');
  if(!['AOG','A','B','C','D'].includes(body.decision))fail(400,'Неизвестная категория');
  if(body.decision!=='AOG'&&!(Date.parse(body.until)>Date.now()))fail(400,'Укажите будущий срок отложения');
  c.aog=body.decision==='AOG';c.mel=c.aog?null:body.decision;c.until=c.aog?null:body.until;
  log('engineering-decision',user.id,c,{requestId:receipt,aog:c.aog,mel:c.mel,until:c.until});return send(c);
 }
 if(path==='/api/control'&&post&&user.role==='dispatcher'){
  const c=history.get(body.number);
  if(!c||!['working','waiting','assigned','enroute','arrived'].includes(c.status)||typeof body.reason!=='string'||!body.reason.trim())fail(409,'Укажите действующую заявку и причину');
  const from=c.status;
  if(from==='working'&&(!user.supervisor||body.confirmed!==true))fail(403,'Начатую работу может снять только старший смены с подтверждением');
  if(from==='assigned'&&c.offers?.at(-1))Object.assign(c.offers.at(-1),{outcome:'returned',endedAt:Date.now()});
  delete c.replyBy;
  for(const [id,j] of jobs)if(j.number===c.number){jobs.delete(id);clearWorkEstimate(id,c.number)}
  c.status='pending';delete c.vehicle;delete c.boarded;delete c.disembarked;c.firstArrivalAt??=c.arrivedAt;c.previousArrival=c.arrivedAt;delete c.arrivedAt;delete c.acceptedAt;
  pending.set(c.number,c);log('reassignment',user.id,c,{from,reason:body.reason,confirmed:body.confirmed===true});processQueue();return send(c);
 }
 if(path==='/api/history'&&!post&&user.role==='dispatcher')return send([...history.values()].map(c=>({number:c.number,status:c.status,zone:c.zone,aog:c.aog})));
 if((path==='/api/action'||path==='/api/done')&&post&&user.role==='engineer'){
   const call=jobs.get(user.id);
   if(!call||call.number!==body.number)fail(409,'Назначение изменилось');
   const action=path==='/api/done'?'done':body.action;
   if(!['accept','reject','start','done','wait'].includes(action))fail(400,'Недоступное действие');
   const now=Date.now();
   if(['accept','reject'].includes(action)&&body.offerAt!==undefined&&body.offerAt!==call.assignedAt)fail(409,'Предложение изменилось. Обновите задание.');
   if(call.status==='assigned'&&now>=(call.replyBy??call.assignedAt+offerMs)){processQueue();fail(409,'Время ответа истекло')}
   if(action==='reject'&&call.status==='assigned'){
    releaseOffer(call,user.id,'rejected',now,receipt);processQueue();return send({number:call.number,status:call.status});
   }
   transition(call,action,now);
   if(action==='accept'&&call.offers?.at(-1)){
    Object.assign(call.offers.at(-1),{outcome:'accepted',endedAt:now});delete call.replyBy;
   }
   if(action==='done'||action==='wait'){jobs.delete(user.id);clearWorkEstimate(user.id,call.number)}
   log('status',user.id,call,{requestId:receipt,action,status:call.status});

   processQueue();
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
   if(body.remarkId&&(!remark||remark.call||(remark.requiresReview&&!remark.reviewedAt)))fail(409,'Замечание уже обработано или не найдено');
   if(body.scheduled&&!Number.isFinite(Date.parse(body.scheduled)))fail(400,'Проверьте время прибытия ВС');
   if(typeof tail!=='string'||tail.length>24)fail(400,'Проверьте номер борта');
   if(custom){defect=Object.keys(defects).find(k=>defects[k][0]===custom&&defects[k][1]==='ATA '+body.ata)||'CUSTOM-'+randomBytes(6).toString('hex');defects[defect]=[custom,'ATA '+body.ata]}
   const call={number:nextCall++,createdAt:Date.now(),status:'pending',forceVehicle:body.forceVehicle===true,manualFirst:body.manualFirst===true,zone,aircraft:type,defect,priority,tail:tail.trim()};
   history.set(call.number,call);
   if(remark){call.remarkId=remark.id;remark.call=call.number}
   if(body.scheduled){call.scheduled=body.scheduled;db.record('aircraft-schedule',user.id,call,{tail,scheduled:call.scheduled})}
   call.ata=Number(defects[defect][1].split(' ')[1]);call.kit=!!body.kit;
   call.description=defects[defect].join(' · ');call.source=['Экипаж','Сотрудник','MCC/ЦПУ'].includes(body.source)?body.source:'Экипаж';
   if(remark)call.source=remark.source||'Сотрудник';
   if(!remark?.reviewedAt)log('mcc-reviewed',user.id,call,{remarkId:remark?.id,source:call.source,note:remark?.note||call.description,mode:'Приём и обработка при регистрации'});
   if(remark){call.remarkNote=remark.note;call.reviewer=remark.reviewer||user.id}
   call.melHistory=call.tail?[...history.values()].filter(old=>old.number!==call.number&&old.tail===call.tail&&old.mel).map(old=>({number:old.number,mel:old.mel,until:old.until})):[];
   pending.set(call.number,call);log('registered',user.id,call,{...call});processQueue();return send(call);
 }
 if(path.startsWith('/api/') || (path==='/scenarios' && user.role!=='dispatcher'))fail(403,'Доступ ограничен');
 const file=files.get(path);
 if(!file || post)fail(404,'Страница не найдена');
 res.setHeader('Content-Type',file[1]+'; charset=utf-8');
 res.end(readFileSync(new URL(file[0],import.meta.url)));
}
const handler=(req,res)=>handle(req,res).catch(e=>{res.statusCode=e.status||500;if(req.url?.split('?')[0]==='/api/v1/track'&&[400,413,415].includes(res.statusCode))db.record('track-error','Источник',null,{status:res.statusCode,reason:e.message});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.status?e.message:'Ошибка сервера'}));});
const server=tls?https.createServer({key:readFileSync(process.env.TLS_KEY),cert:readFileSync(process.env.TLS_CERT)},handler):http.createServer(handler);
server.on('error',error=>{
  console.error(error.code==='EADDRINUSE'?'Адрес уже занят. Если сайт уже открыт, используйте коды работающей смены.':error.message);
  process.exitCode=1;
});
server.listen(port,host,()=>{
  setInterval(()=>{processQueue();for(const [id,c] of jobs)if(!c.arrivedAt)activeView(id)},1000).unref();
  if(!process.env.RENDER)for(const [code,account] of accounts)console.log(account.id+' — '+code);
  console.log('Перрон-15 · '+(tls?'https':'http')+'://'+host+':'+server.address().port);
});

