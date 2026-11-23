import http from 'node:http';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {aircraft,defects,priorities} from './calls.mjs';

const accounts = new Map();
const sessions = new Map();
const points = new Map();
const jobs = new Map();
const pending = new Map();
let nextCall = 1;
const attempts = new Map();
const tls = process.env.TLS_CERT && process.env.TLS_KEY;
const port = Number(process.env.PORT || 8175);
const host = process.env.HOST || '127.0.0.1';
if (!tls && !['127.0.0.1','localhost','::1'].includes(host) && process.env.TRUST_HTTPS_PROXY !== 'yes') {
  throw Error('Для сети настройте HTTPS (TLS_CERT и TLS_KEY) или защищённый обратный прокси.');
}
for (const [id,role] of [['Диспетчер','dispatcher'],['Инженер 1','engineer'],['Инженер 2','engineer']]) {
  const code = process.env[['DISPATCH_CODE','ENGINEER_ONE_CODE','ENGINEER_TWO_CODE'][accounts.size]] || randomBytes(8).toString('hex');
  accounts.set(code,{id,role});
}
const files = new Map(Object.entries({
  '/':['index.html','text/html'], '/ui.js':['ui.js','text/javascript'],
  '/route.js':['route.js','text/javascript'], '/style.css':['style.css','text/css'],
  '/scenarios':['scenarios.html','text/html'],
  '/calls.mjs':['calls.mjs','text/javascript'],
  ...Object.fromEntries(['roads','objects','airport_boundaries','service_zones'].map(n=>['/data/'+n,['data/'+n+'.geojson','application/json']]))
}));
function fail(status,message){throw Object.assign(Error(message),{status});}
async function handle(req,res){
 const path = req.url.split('?')[0];
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
   let raw=''; for await(const chunk of req){raw+=chunk;if(raw.length>4096)fail(413,'Слишком большой запрос');}
   try{body=JSON.parse(raw);}catch{fail(400,'Ошибка данных');}
   if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Ошибка данных');
 }
 if(path==='/api/login' && post){
   const ip=req.socket.remoteAddress;
   const recent=(attempts.get(ip)||[]).filter(t=>Date.now()-t<60000);
   if(recent.length>=12)fail(429,'Попробуйте через минуту');
   const account=accounts.get(body.code);
   if(!account || account.role!==body.role){attempts.set(ip,[...recent,Date.now()]);fail(401,'Проверьте роль и код смены');}
   const sid=randomBytes(32).toString('hex');
   sessions.set(sid,{user:account,until:Date.now()+12*3600000});
   res.setHeader('Set-Cookie','shift='+sid+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(tls || process.env.TRUST_HTTPS_PROXY==='yes'?'; Secure':''));
   return send(account);
 }
 if(path==='/api/me' && !post)return send(user);
 if(path.startsWith('/api/') || path.startsWith('/data/') || path==='/scenarios'){
   if(!user)fail(401,'Войдите в смену');
 }
 if(path==='/api/logout' && post){sessions.delete(token);if(user.role==='engineer')points.delete(user.id);res.setHeader('Set-Cookie','shift=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');return send({});}
 if(path==='/api/point' && post && user.role==='engineer'){
   if(body.stop){points.delete(user.id);return send({});}
   const {lat,lon,accuracy,time}=body;
   if(![lat,lon,accuracy,time].every(Number.isFinite)||Math.abs(lat)>90||Math.abs(lon)>180||accuracy<0||Date.now()-time>60000||time>Date.now()+5000)fail(400,'Координаты устарели или некорректны');
   if(!points.has(user.id)||points.get(user.id).time<=time)points.set(user.id,{lat,lon,accuracy,time});
   return send({});
 }
 if(path==='/api/team' && !post && user.role==='dispatcher')return send([...accounts.values()].filter(a=>a.role==='engineer').map(a=>({id:a.id,point:points.get(a.id),job:jobs.get(a.id)})));
 if(path==='/api/job' && !post && user.role==='engineer')return send(jobs.get(user.id)||null);
 if(path==='/api/calls' && user.role==='dispatcher'){
   if(!post)return send([...pending.values()].sort((a,b)=>a.priority.localeCompare(b.priority)||a.number-b.number));
   const {zone,aircraft:type,defect,priority}=body;
   if(!Number.isInteger(zone)||zone<1||zone>10||!aircraft.includes(type)||!Object.hasOwn(defects,defect)||!Object.hasOwn(priorities,priority))fail(400,'Проверьте параметры вызова');
   const tail=body.tail??'';
   if(typeof tail!=='string'||tail.length>24)fail(400,'Проверьте номер борта');
   const call={number:nextCall++,zone,aircraft:type,defect,priority,tail:tail.trim()};
   pending.set(call.number,call);return send(call);
 }
 if(path==='/api/done' && post && user.role==='engineer'){jobs.delete(user.id);return send({});}
 if(path==='/api/assign' && post && user.role==='dispatcher'){
   const p=points.get(body.id);
   if(!p || Date.now()-p.time>60000 || p.accuracy>50 || jobs.has(body.id) || p.time!==body.time)fail(409,'Состояние изменилось, обновите расчёт');
   if(!Number.isInteger(body.zone)||body.zone<1||body.zone>10)fail(400,'Неизвестная зона');
   const call=pending.get(body.number);
   if(!call || call.zone!==body.zone)fail(409,'Выберите открытый вызов');
   jobs.set(body.id,call);pending.delete(call.number);return send({});
 }
 if(path.startsWith('/api/') || (path==='/scenarios' && user.role!=='dispatcher'))fail(403,'Доступ ограничен');
 const file=files.get(path);
 if(!file || post)fail(404,'Страница не найдена');
 res.setHeader('Content-Type',file[1]+'; charset=utf-8');
 res.end(readFileSync(new URL(file[0],import.meta.url)));
}
const handler=(req,res)=>handle(req,res).catch(e=>{res.statusCode=e.status||500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:e.status?e.message:'Ошибка сервера'}));});
const server=tls?https.createServer({key:readFileSync(process.env.TLS_KEY),cert:readFileSync(process.env.TLS_CERT)},handler):http.createServer(handler);
server.on('error',error=>{
  console.error(error.code==='EADDRINUSE'?'Адрес уже занят. Если сайт уже открыт, используйте коды работающей смены.':error.message);
  process.exitCode=1;
});
server.listen(port,host,()=>{
  if(!process.env.RENDER)for(const [code,account] of accounts)console.log(account.id+' — '+code);
  console.log('Перрон-15 · '+(tls?'https':'http')+'://'+host+':'+server.address().port);
});

