import {createOutbox} from './outbox.js';
import {rosterEditor} from './roster.js';
import {forbiddenObjects,positionStatus} from './access.mjs';
import {network,xy,setOrigin,center} from './route.js';
import {aircraft,defects,priorities,describe} from './calls.mjs';
import {labels} from './lifecycle.mjs';
let activeJob;
const el=id=>document.getElementById(id);
let account,watch=null,timer,geo,route,best,tracking=0,queue=Promise.resolve(),revision=0;
const notice=msg=>{el('notice').textContent=msg;};
async function api(name,data){
 const res=await fetch('/api/'+name,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const result=await res.json();
 if(!res.ok){if(res.status===401 && account)location.reload();throw Object.assign(Error(result.error),{status:res.status});}
 return result;
}
let outbox,voice=false,spoken='';
function speak(message){
 if(!voice||!message||spoken===message)return;
 spoken=message;const line=new SpeechSynthesisUtterance(message);line.lang='ru-RU';speechSynthesis.cancel();speechSynthesis.speak(line);
}
el('voice').onclick=()=>{
 if(!('speechSynthesis' in window)){notice('Браузер не поддерживает озвучивание');return}
 voice=!voice;spoken='';el('voice').textContent=voice?'Выключить голосовые подсказки':'Включить голосовые подсказки';
 if(voice)speak(el('guidance').textContent||'Голосовые подсказки включены');else speechSynthesis.cancel();
};
const roster=rosterEditor(api,()=>refresh(),aircraft,defects);
async function load(user){
 account=user;
 for(const [id,show] of [['entry',!user],['mcc',user?.role==='mcc'],['engineer',user?.role==='engineer'],['dispatch',user?.role==='dispatcher'],['logout',!!user]])el(id).hidden=!show;
 if(!user)return;
 el('identity').textContent=user.supervisor?'Старший смены · диспетчер':user.id;
 if(user.role==='mcc'){await refresh();timer=setInterval(refresh,3000);return}
 if(user.role==='engineer'){
  outbox=createOutbox(user,api,msg=>{el('sync').textContent=msg});
  window.addEventListener('online',()=>outbox.flush().then(()=>refresh()));
 }
 if(user.supervisor)for(const [role,title] of [['mcc','Выдать код сотруднику MCC'],['dispatcher','Выдать код диспетчеру']])control(title,async()=>{
  const result=await api('staff-code',{role});prompt('Вход через «Диспетчер» · '+result.id,result.code)
 });
 {
   const layers=await Promise.all(['roads','service_zones','objects','airport_boundaries'].map(async n=>(await fetch('/data/'+n)).json()));
   geo={roads:layers[0],zones:layers[1].features,objects:layers[2].features,bounds:layers[3].features};
   const site=await (await fetch('/site.json')).json();imageryBounds=site.imageryBounds||boundsOf(geo.bounds);geo.barriers=forbiddenObjects(geo.objects,site.blockedObjects);
   setOrigin(layers[3]);document.querySelector('.maphead span').textContent=geo.zones.length+' зон';document.querySelector('.maphead h2').textContent=site.name;
   if(user.role==='engineer')el('engineer').append(document.querySelector('.mapbox'));
   for(const model of aircraft)el('aircraft').add(new Option(model,model));
   Object.assign(defects,await api('catalog'));filterDefects();
   for(const [id,name] of Object.entries(priorities))el('priority').add(new Option(name,id));
   el('priority').value='B';
   for(const z of geo.zones)el('zone').add(new Option((z.properties.name||'Зона обслуживания '+z.properties.id),z.properties.id));
 }
 await refresh();timer=setInterval(refresh,3000);
}
el('login').onsubmit=async ev=>{
 ev.preventDefault();notice('');
 try{const user=await api('login',{role:new FormData(ev.target).get('role'),code:el('code').value.trim()});el('code').value='';await load(user);}catch(e){notice(e.message);}
};
function stopWatch(){tracking++;if(watch!==null)navigator.geolocation.clearWatch(watch);watch=null;}
el('logout').onclick=async()=>{try{stopWatch();await queue;await api('logout',{});clearInterval(timer);location.reload();}catch(e){notice(e.message);}};
el('track').onclick=async()=>{
 if(watch!==null){
   stopWatch();el('track').disabled=true;
   try{await queue;await api('point',{stop:true});el('gps').textContent='Передача выключена.';}catch(e){notice(e.message);}
   el('track').textContent='Включить GPS';el('track').disabled=false;return;
 }
 if(!window.isSecureContext || !navigator.geolocation){notice('Для GPS откройте сайт по HTTPS или через localhost.');return;}
 const gen=++tracking;
 el('gps').textContent='Ожидание координат телефона…';el('track').textContent='Остановить передачу';
 watch=navigator.geolocation.watchPosition(p=>{
   queue=queue.then(async()=>{
    if(gen!==tracking)return;
    const result=await api('v1/track',{obj:account.obj,lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy,t:new Date(p.timestamp).toISOString()});
    if(!result.applied)throw Error('Точка не применена: проверьте время GPS');
    if(gen===tracking)el('gps').textContent='Передано в '+new Date(p.timestamp).toLocaleTimeString('ru')+' · точность ±'+Math.round(p.coords.accuracy)+' м';
   }).catch(e=>notice(e.message));
 },e=>{if(gen!==tracking)return;el('gps').textContent=e.code===1?'Доступ к геолокации запрещён. Разрешите его в браузере.':'Нет свежих координат. Проверьте сигнал.';if(e.code===1){stopWatch();el('track').textContent='Включить GPS';}},{enableHighAccuracy:true,maximumAge:0,timeout:20000});
};
function shape(tag,attrs,label){
 const n=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);
 if(label)n.textContent=label;el('map-overlay').append(n);return n;
}
const points=coords=>coords.map(p=>p.join(',')).join(' ');
function updateRoads(closed){
 const key=JSON.stringify(closed);
 if(geo.closureKey===key)return;
 geo.closureKey=key;geo.closed=closed;
 geo.walk=network(geo.roads,'walk',closed,geo.barriers);
}
let lastMap;
// The service returns a north-up geographic raster. Its aspect ratio in degrees
// matches the requested bounding box, so the service does not expand either axis.
let imageryBounds;
function boundsOf(features){
 const pts=features.flatMap(f=>f.geometry.coordinates.flat(2)),xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);
 return {west:Math.min(...xs),east:Math.max(...xs),south:Math.min(...ys),north:Math.max(...ys)};
}
const imagery=el('satellite-image');
let layer='plan',imageState='idle',imageError='';
try{if(localStorage.getItem('perron-map-layer')==='satellite')layer='satellite'}catch{}
function selectLayer(next){
 layer=next;imageError='';
 try{localStorage.setItem('perron-map-layer',next)}catch{}
 if(lastMap)draw(...lastMap);
}
el('layer-plan').onclick=()=>selectLayer('plan');
el('layer-satellite').onclick=()=>selectLayer('satellite');
imagery.addEventListener('load',()=>{
 imageState='ready';
 if(lastMap&&layer==='satellite')draw(...lastMap);
});
imagery.addEventListener('error',()=>{
 imageState='idle';imagery.removeAttribute('href');
 if(layer!=='satellite')return;
 selectLayer('plan');imageError='Снимок не загрузился. Можно повторить кнопкой «Спутник».';
 el('imagery-status').textContent=imageError;
});
function drawBackground([x,y,width,height]){
 const {west,south,east,north}=imageryBounds;
 const [left,top]=xy([west,north]),[right,bottom]=xy([east,south]);
 const intersects=x<right&&x+width>left&&y<bottom&&y+height>top;
 const requested=layer==='satellite';
 if(requested&&intersects&&imageState==='idle'){
  imageState='loading';
  for(const [key,value] of Object.entries({x:left,y:top,width:right-left,height:bottom-top}))imagery.setAttribute(key,value);
  const params=new URLSearchParams({bbox:[west,south,east,north].join(','),bboxSR:'4326',imageSR:'4326',size:'2050,1200',format:'jpg',f:'image'});
  imagery.setAttribute('href','https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?'+params);
 }
 const visible=requested&&intersects&&imageState==='ready';
 imagery.setAttribute('visibility',visible?'visible':'hidden');
 el('map').classList.toggle('satellite-map',visible);
 el('imagery-credit').hidden=!visible;
 el('layer-plan').setAttribute('aria-pressed',String(!requested));
 el('layer-satellite').setAttribute('aria-pressed',String(requested));
 el('imagery-status').textContent=requested&&!intersects?'За пределами спутникового снимка полигона.':requested&&!visible?'Загружаем снимок полигона…':imageError;
}
el('focus').onchange=()=>{if(lastMap)draw(...lastMap)};
function draw(team,zone){
 lastMap=[team,zone];
 const map=el('map'),focus=el('focus'),engineers=team.filter(t=>t.kind==='engineer');
 const selected=focus.value;
 const places=[...geo.objects.map(f=>({key:'object:'+f.properties.id,name:f.properties.name,xy:center(f)})),...geo.zones.map(f=>({key:'zone:'+f.properties.id,name:f.properties.name||'Зона '+f.properties.id,xy:center(f)}))];
 const options=[...engineers.map(t=>({key:t.obj,name:t.id})),...places];
 if([...focus.options].slice(1).map(o=>o.value).join('|')!==options.map(t=>t.key).join('|')){
  focus.replaceChildren(new Option('Весь полигон',''),...options.map(t=>new Option(t.name,t.key)));
  focus.value=options.some(t=>t.key===selected)?selected:(account.role==='engineer'?account.obj:'');
 }
 el('map-overlay').replaceChildren();
 const hatch=shape('pattern',{id:'restricted',patternUnits:'userSpaceOnUse',width:12,height:12});
 hatch.append(shape('rect',{width:12,height:12,fill:'#ffe1d8',class:'hatch-base'}),shape('path',{d:'M-2 2L2 -2M0 12L12 0M10 14L14 10',stroke:'#c65b47','stroke-width':2}));
 const defs=shape('defs',{});defs.append(hatch);
 function area(f,fill,stroke,width,kind){
  const d=f.geometry.coordinates.flatMap(poly=>poly.map(ring=>'M'+ring.map(p=>xy(p).join(',')).join('L')+'Z')).join(' ');
  shape('path',{d,fill,stroke,class:kind,'fill-rule':'evenodd','stroke-width':width});
 }
 geo.bounds.forEach(f=>area(f,'#fbfaf0','#85989c',2,'boundary'));
 geo.objects.filter(f=>!geo.barriers.includes(f)).forEach(f=>area(f,'#d7dfe1','#9daeb2',2,'building'));
 for(const road of geo.roads.features){
  const closed=geo.closed.includes(road.properties.id);
  shape('polyline',{points:points(road.geometry.coordinates.map(xy)),fill:'none',class:closed?'closed-road':'base-road',stroke:closed?'#624956':'#c9d1cf','stroke-width':closed?4:2,'stroke-dasharray':closed?'8 6':'none'});
 }
 shape('path',{d:geo.walk.segments.map(([a,b])=>'M'+a+'L'+b).join(' '),fill:'none',class:'walk-road',stroke:'#278257','stroke-width':4,'stroke-linecap':'round'});
 for(const z of geo.zones)area(z,z===zone?'#f5cc5c55':'#97c6b02e',z===zone?'#976900':'#5d8a79',z===zone?3:1.5,'service-zone');
 geo.barriers.forEach(f=>area(f,'url(#restricted)','#a83229',3,'barrier'));
 if(best)shape('polyline',{points:points(best.route.path),fill:'none',class:'chosen-route',stroke:'#176b87','stroke-width':7,'stroke-linejoin':'round'});
 for(const t of team)if(t.job?.route&&!t.job.arrivedAt)shape('polyline',{points:points(t.job.route.path),fill:'none',class:'chosen-route',stroke:'#176b87','stroke-width':7});
 const focused=engineers.find(t=>t.obj===focus.value)?.point;
 const location=places.find(p=>p.key===focus.value)?.xy||(focused&&xy([focused.lon,focused.lat]));
 const zoom=!!location;
 const all=geo.bounds.flatMap(f=>f.geometry.coordinates.flat(2).map(xy)),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]);
 let box=[Math.min(...xs)-45,Math.min(...ys)-45,Math.max(...xs)-Math.min(...xs)+90,Math.max(...ys)-Math.min(...ys)+90];
 if(zoom){const [x,y]=location;box=[x-140,y-140,280,280]}
 map.setAttribute('viewBox',box.join(' '));
 drawBackground(box);
 function label(x,y,title,size,anchor='middle'){
  shape('text',{x,y,'font-size':size,'text-anchor':anchor,fill:'#19343d',stroke:'white','stroke-width':size/5,'paint-order':'stroke'},title);
 }
 for(const f of geo.objects){const [x,y]=center(f);label(x,y,f.properties.name,zoom?8:17)}
 for(const z of geo.zones){
  const [x,y]=center(z),r=zoom?6:16;shape('circle',{cx:x,cy:y,r,fill:z===zone?'#edb02c':'#fff',stroke:'#71828a','stroke-width':1.5});
  label(x,y+r*.4,z.properties.name||String(z.properties.id),r*1.1);
 }
 const colors={blocked:'#a92b24',uncertain:'#986000',unknown:'#596b76',outside:'#535867',open:'#145c40'};
 el('positions').replaceChildren();
 for(const t of team){
  const p=t.point,isEngineer=t.kind==='engineer';
  const info=isEngineer?positionStatus(p,geo.barriers,geo.bounds,geo.walk):null;
  const color=info?colors[info.level]:(t.kind==='aircraft'?'#963c61':'#324e99');
  if(isEngineer){
   const row=document.createElement('div'),title=document.createElement('strong'),status=document.createElement('span');
   row.className='positionrow';row.style.borderLeftColor=color;title.textContent=t.id;status.textContent=p?.source==='start'?'Стартовая позиция из файла':info.text;row.append(title,status);
   if(p){const stamp=document.createElement('small');stamp.textContent=p.source==='start'?'Ожидаем первую фактическую точку':'GPS '+new Date(p.time).toLocaleTimeString('ru')+' · ±'+Math.round(p.accuracy)+' м';row.append(stamp)}
   el('positions').append(row);
  }
  if(!p)continue;
  const stale=p.stopped||(p.source!=='start'&&Date.now()-p.time>60000);
  const [x,y]=xy([p.lon,p.lat]),r=zoom?3.5:10;
  if(isEngineer)shape('circle',{cx:x,cy:y,r:p.accuracy,fill:color,'fill-opacity':.12,stroke:color,'stroke-width':zoom?1:2,'stroke-dasharray':'3 3'});
  shape('circle',{cx:x,cy:y,r,fill:stale?'#879297':color,stroke:'#fff','stroke-width':zoom?1:2});
  label(x+r+2,y-r,t.id+(t.enabled===false?' · снят':'')+(p.source==='start'?' · старт':'')+(stale?' · последняя позиция':''),zoom?7:17,'start');
 }
}
const timeRu=ms=>new Date(ms).toLocaleTimeString('ru');
const offerLabels={offered:'Отправлено',accepted:'Принято',rejected:'Отклонено',timeout:'Нет ответа',busy:'Указал занятость',returned:'Возвращено в очередь'};
async function setAvailability(minutes){
 try{await outbox.submit('availability',{minutes,statedAt:Date.now()});await refresh()}catch(e){notice(e.message)}
}
el('availability-form').onsubmit=e=>{e.preventDefault();setAvailability(el('busy-minutes').valueAsNumber)};
el('available-now').onclick=()=>setAvailability(0);
function timing(f){
 const seconds=Math.ceil(Math.abs(f.marginMs)/1000);
 return 'ETA '+new Date(f.eta).toLocaleTimeString('ru')+' · '+(f.inTime?'запас ':'опоздание ')+Math.floor(seconds/60)+' мин '+seconds%60+' с';
}
async function refresh(prefer){
 const seq=++revision;
 try{
  if(account.role==='mcc'){
   const rows=await api('mcc');if(seq!==revision)return;
   el('mcc-list').replaceChildren(...rows.map(r=>{const b=document.createElement('button');b.textContent=r.note+' · Проверить и передать';b.onclick=async()=>{try{await api('mcc',{id:r.id});await refresh()}catch(e){notice(e.message)}};return b}));return;
  }
  if(account.role==='engineer'){
   await outbox.flush();
   const [job,visible,closed]=await Promise.all([api('job'),api('agents'),api('roads')]);if(seq!==revision)return;updateRoads(closed);
   activeJob=job;
   el('busy-label').textContent=job?.status==='working'?'До завершения текущей работы, минут':'Занят другим бортом ещё, минут';
   const until=visible.find(a=>a.obj===account.obj)?.busyUntil||0;
   el('availability-status').textContent=until>Date.now()?'Занят до '+timeRu(until):job&&job.status!=='assigned'?'Выполняю заявку № '+job.number:'Свободен';

   el('myjob').textContent=job?[describe(job),labels[job.status],job.arrivedAt?'Прибытие '+new Date(job.arrivedAt).toLocaleTimeString()+' · '+(job.inLimit?'в нормативе':'с опозданием'):job.route?'До зоны '+job.route.minutes.toFixed(1)+' мин':job.routeReason||'Ожидание GPS'].join(' · '):'Ожидание назначения';
   if(job){el('myjob').textContent+=(job.kit?' · Комплект '+(job.kitCollected?'получен':'получить на складе'):'')+(job.route?' · '+job.route.mode:'')+(job.aircraftNear?' · Рядом ВС '+job.aircraftNear:'');}
   if(job?.remarkNote)el('myjob').textContent+=' · Замечание: '+job.remarkNote;
   if(job)el('myjob').textContent+=' · '+job.targetSource+(job.arrivalZone===null?' · борт вне зоны обслуживания':'')+(job.status==='assigned'&&job.replyBy?' · Ответить до '+timeRu(job.replyBy):'');
   const hint=job?.route&&!job.arrivedAt?
    [job.aircraftNear?'Внимание, поблизости воздушное судно '+job.aircraftNear:'',
     job.vehicle&&!job.boarded?'Пройдите к машине '+job.vehicle:job.kit&&!job.kitCollected?'Следуйте к складу за комплектом':'Следуйте по выделенному маршруту к борту',
     'Зона '+(job.arrivalZone??job.zone)].filter(Boolean).join('. '):'';
   el('guidance').textContent=hint+(hint&&job.eta?' · ETA '+timeRu(job.eta):'');speak(hint);
   best=job?.route?{route:job.route}:null;
   draw(visible,geo.zones.find(z=>z.properties.id===job?.arrivalZone));
   const buttons=el('actions');buttons.replaceChildren();
   if(job?.kit){const tool=document.createElement('button');tool.textContent=job.kitCollected?'Отметить отсутствие комплекта':'Подтвердить наличие комплекта';tool.onclick=async()=>{try{await outbox.submit('tool',{number:job.number,collected:!job.kitCollected});await refresh()}catch(e){notice(e.message)}};buttons.append(tool)}
   if(job&&job.atlbHistory?.length){
    const records=document.createElement('div');records.textContent='ATLB · '+job.atlbHistory.map(r=>r.ref+' · '+r.description+' · MEL '+r.mel+' до '+r.until).join(' / ');buttons.append(records)
   }
   if(job?.status==='working'){
    const decision=document.createElement('button');decision.textContent='AOG / отложить по MEL';decision.onclick=async()=>{
     const value=prompt('AOG или категория MEL A/B/C/D');if(!value)return;
     const until=value==='AOG'?null:prompt('Срок отложения в формате ГГГГ-ММ-ДДTчч:мм');
     try{await outbox.submit('decision',{number:job.number,decision:value.toUpperCase(),until:until?new Date(until).toISOString():null});await refresh()}catch(e){notice(e.message)}
    };buttons.append(decision);
    if(job.melHistory?.length)buttons.append(document.createTextNode('Предыдущие MEL: '+job.melHistory.map(h=>h.mel+' до '+h.until).join(', ')));
   }
   const actions={assigned:[['accept','Принять'],['reject','Отклонить']],arrived:[['start','Начать работы']],working:[['done','Завершить работы'],['wait','Ожидать запчасть']]};
   for(const [action,title] of actions[job?.status]||[]){const btn=document.createElement('button');btn.textContent=title;btn.onclick=async()=>{btn.disabled=true;try{await outbox.submit('action',{action,number:job.number,offerAt:job.assignedAt});await refresh()}catch(e){notice(e.message)}};buttons.append(btn)}
   return;
  }
  const [team,calls,agents,remarks,closed]=await Promise.all([api('team'),api('dispatch'),api('agents'),api('remarks'),api('roads')]);if(seq!==revision)return;updateRoads(closed);
  roster.update(agents);
  const tails=agents.filter(a=>a.kind==='aircraft').map(a=>a.obj);
  if(tails.join('|')!==Array.from(el('tracked-aircraft').options,o=>o.value).join('|'))el('tracked-aircraft').replaceChildren(...tails.map(t=>new Option(t,t)));
  const selected=el('remark').value;el('remark').replaceChildren(new Option('Регистрация вручную',''),...remarks.map(r=>new Option(r.author+' · '+r.note,r.id)));if(remarks.some(r=>r.id===selected))el('remark').value=selected;
  const picker=el('pending');
  const current=calls.find(c=>c.number===(prefer??Number(picker.value)))??calls[0];
  picker.replaceChildren(...calls.map(c=>new Option('№ '+c.number+' · '+c.aircraft+' · зона '+c.zone+' · '+labels[c.status],c.number)));
  if(current)picker.value=String(current.number);
  else picker.add(new Option('Заявок пока нет',''));
  picker.disabled=!current;
  el('call-detail').textContent=current?[describe(current),labels[current.status],current.targetSource,current.arrivalZone===null?'Борт вне зоны обслуживания':'',current.status==='pending'?(current.manualFirst&&!current.offers?.length?'Ожидает выбора диспетчера':'Автоподбор ожидает подходящего инженера'):'',current.arrivedAt?'Прибытие '+timeRu(current.arrivedAt)+' · '+(current.inLimit?'в нормативе':'опоздание'):current.breachAt?'Срок прибытия истёк':''].filter(Boolean).join(' · '):'Зарегистрируйте вызов для автоматической отправки.';
  if(current?.status==='pending'&&current.queueRisk)el('call-detail').textContent+=' · Риск срыва: на текущих данных никто не успевает к сроку.';
  el('offer-history').replaceChildren(...(current?.offers||[]).map(offer=>{
   const item=document.createElement('li');item.textContent=offer.engineer+' · отправлено '+timeRu(offer.at)+' · '+offerLabels[offer.outcome]+(offer.endedAt?' '+timeRu(offer.endedAt):offer.outcome==='offered'?' · ответ до '+timeRu(offer.replyBy):'');return item;
  }));
  const editable=current&&['assigned','pending','enroute'].includes(current.status);
  el('trial-panel').hidden=!editable;
  el('trial-status').textContent=[current?.testDeadline?'Тестовый срок '+timeRu(current.testDeadline):'Обычный срок 15 минут',current?.forceVehicle?'Транспорт обязателен':'Автовыбор маршрута'].join(' · ');
  el('trial-transport').textContent=current?.forceVehicle?'Вернуть автовыбор':'Обязать использовать транспорт';
  el('trial-transport').onclick=()=>trial(current.number,{forceVehicle:!current.forceVehicle});
  el('trial-clock').onclick=()=>trial(current.number,{remainingSeconds:el('trial-seconds').valueAsNumber});
  const v3=agents.find(a=>a.obj==='vehicle-03');
  el('vehicle-03').hidden=!v3;el('vehicle-03').textContent=v3?.enabled===false?'Включить vehicle-03 в испытание':'Снять vehicle-03 с испытания';
  el('vehicle-03').onclick=async()=>{try{await api('vehicle-participation',{enabled:v3.enabled===false});await refresh()}catch(e){notice(e.message)}};
  if(current?.testDeadline||current?.forceVehicle)el('call-detail').textContent+=' · Испытание';
  const offer=current?.offers?.at(-1);
  el('comparison').replaceChildren(...(offer?.comparison||[]).map(c=>{
   const item=document.createElement('li');
   const why=c.reason||['Допуск ATA '+c.ata,c.mode,Math.round(c.meters)+' м',c.waitMinutes>0?'занят ещё '+Math.ceil(c.waitMinutes)+' мин':'свободен',timing(c.forecast)].join(' · ');
   item.textContent=c.id+' · '+(c.id===offer.engineer?'Выбран · ':'')+why+(c.alternatives?.length>1?' · варианты: '+c.alternatives.map(v=>v.mode+' '+v.minutes.toFixed(1)+' мин').join(', '):'')+(c.impact?' · по срочной № '+c.impact.number+' останется '+(c.impact.engineer||'никого'):'');return item
  }));
  const zone=geo.zones.find(z=>z.properties.id===(current?current.arrivalZone:Number(el('zone').value)));
  best=null;el('team').replaceChildren();
  const ranking=current?.status==='pending'?await api('rank?number='+current.number):[];if(seq!==revision)return;
  const leader=ranking[0];
  if(leader?.route&&leader.busyUntil>Date.now())el('call-detail').textContent+=' · Быстрее прибудет '+leader.id+' после освобождения в '+timeRu(leader.busyUntil)+'. '+timing(leader.forecast);
  if(current?.status==='pending'&&!leader?.route)el('call-detail').textContent+=' · Сейчас нет кандидата с допуском, свежим GPS и доступным маршрутом для отправки.';
  for(const t of team){
   let status;
   const p=t.point;
   if(t.job)status=[describe(t.job),labels[t.job.status],t.job.arrivedAt?'Факт '+new Date(t.job.arrivedAt).toLocaleTimeString():t.job.eta?'ETA '+new Date(t.job.eta).toLocaleTimeString():t.job.routeReason||'Нет свежего прогноза',t.job.risk?'Риск срыва: проверьте свободных инженеров и переназначение':''].filter(Boolean).join(' · ');
   else if(!p||p.stopped||(p.source==='start'&&t.id==='AT-0001'))status='Ожидаем GPS телефона';
   else if(p.source!=='start'&&Date.now()-p.time>60000)status='Последняя точка '+timeRu(p.time);
   else if(p.accuracy>50)status='Низкая точность GPS';
   else if(current?.status!=='pending')status='Свободен';
   else{
    const candidate=ranking.find(c=>c.id===t.id),r=candidate?.route;
    if(!r)status=candidate?.reason||'Нет пути';
    else{
     status=r.mode+' · '+Math.round(r.meters)+' м · вызов № '+current.number+': '+timing(candidate.forecast);
     const impact=candidate.impact;
     if(impact){
      status+=' · Срочный № '+impact.number+' сейчас: '+(impact.baseline?timing(impact.baseline):'нет исполнителя');
      status+='; после назначения: '+(impact.remaining?impact.engineer+', '+timing(impact.remaining):'нет свободного исполнителя, время ожидания неизвестно');
     }
     if(candidate.id===ranking[0]?.id)best={id:t.id,time:candidate.time,route:r,zone:zone?.properties.id};
    }
   }
   const busyUntil=agents.find(a=>a.id===t.id)?.busyUntil;
   if(busyUntil>Date.now())status='Занят до '+timeRu(busyUntil)+' · '+(status==='Свободен'?'ожидает освобождения':status);
   if(t.job?.risk){
    const alt=t.job.alternate;
    status+=' · Срок '+new Date((t.job.testDeadline??(t.job.createdAt+900000))).toLocaleTimeString('ru');
    if(!alt)status+=' · Подходящей замены нет';
    else status+=(alt.inTime?' · Успевает замена: ':' · Быстрейшая замена опоздает: ')+alt.id+', '+timing(alt)+(alt.busyUntil>Date.now()?' · освободится в '+timeRu(alt.busyUntil):'');
   }
   if(t.job&&!t.job.arrivedAt)status+=' · До норматива '+Math.max(0,Math.ceil(((t.job.testDeadline??(t.job.createdAt+900000))-Date.now())/1000))+' с';
   if(t.job?.aircraftNear)status+=' · Рядом ВС '+t.job.aircraftNear;
   const row=document.createElement('div'),detail=document.createElement('span');row.className='row';row.textContent=t.id;
   detail.textContent=status+(p?.source==='start'?' · стартовая точка':p?' · '+new Date(p.time).toLocaleTimeString('ru'):'');row.append(detail);
   const choice=ranking.find(r=>r.id===t.id);
   if(current?.manualFirst&&!current.offers?.length&&choice?.route&&!t.job&&!(choice.busyUntil>Date.now())){
    const button=document.createElement('button');button.textContent='Назначить · '+t.id;button.onclick=async()=>{try{await api('assign',{number:current.number,engineer:t.id});await refresh(current.number)}catch(e){notice(e.message)}};row.append(button);
   }
   el('team').append(row);
  }
  if(best)best.number=current.number;
  draw(agents.map(a=>({...a,job:team.find(t=>t.id===a.id)?.job})),zone);
 }catch(e){if(seq!==revision)return;best=null;notice(e.message);}
}
el('zone').onchange=()=>refresh();
el('pending').onchange=()=>refresh();
el('call-form').onsubmit=async event=>{
 event.preventDefault();
 const button=event.currentTarget.querySelector('button');
 button.disabled=true;
 try{
  const call=await api('calls',{forceVehicle:el('force-initial').checked,manualFirst:el('manual-first').checked,zone:Number(el('zone').value),aircraft:el('aircraft').value,tail:el('tail').value,defect:el('defect').value,priority:el('priority').value,text:el('custom').value,ata:Number(el('ata').value),kit:el('kit').checked,source:el('source').value,remarkId:el('remark').value,scheduled:el('scheduled').value?new Date(el('scheduled').value).toISOString():null});
  if(el('custom').value.trim())defects[call.defect]=[el('custom').value.trim(),'ATA '+call.ata];
  if(el('custom').value.trim()){if(!Array.from(el('defect').options).some(o=>o.value===call.defect))el('defect').add(new Option(call.description,call.defect));el('defect').value=call.defect;el('custom').value='';}
  notice('Вызов № '+call.number+' зарегистрирован.');await refresh(call.number);
 }catch(e){notice(e.message);}finally{button.disabled=false;}
};
el('done').replaceWith(Object.assign(document.createElement('div'),{id:'actions'}));
api('me').then(load).catch(e=>notice(e.message));
const controls=document.createElement('article');controls.innerHTML='<h2>Управление сменой</h2><p><a href="/api/log.csv">Скачать журнал CSV</a></p>';
el('dispatch').append(controls);
function control(title,fn){const b=document.createElement('button');b.textContent=title;b.onclick=()=>fn().catch(e=>notice(e.message));controls.append(b)}
function filterDefects(){const q=el('lookup').value.trim().toLowerCase();el('defect').replaceChildren(...Object.entries(defects).filter(([k,v])=>(k+' '+v.join(' ')).toLowerCase().includes(q)).map(([k,v])=>new Option(v.join(' · '),k)))}
el('lookup').oninput=filterDefects;
const report=document.createElement('button');report.textContent='Передать замечание в MCC/ЦПУ';report.onclick=async()=>{const note=prompt('Опишите обнаруженную проблему');if(note)try{await outbox.submit('remarks',{note})}catch(e){notice(e.message)}};el('engineer').append(report);
control('Показатели смены',async()=>{const m=await api('metrics'),v=n=>n===null?'—':n.toFixed(1);notice('Всего '+m.registered+' · без прибытия '+m.withoutArrival+' · в нормативе '+m.onTime+' из '+m.arrived+' ('+v(m.arrived?100*m.onTime/m.arrived:null)+'%) · среднее прибытие '+v(m.meanSeconds)+' с · средняя ошибка первого ETA '+v(m.meanEtaErrorSeconds)+' с · подбор '+v(m.meanSelectionMs)+' мс')});
async function trial(number,values){try{await api('trial',{number,...values});await refresh(number)}catch(e){notice(e.message)}}
const optionalVehicle=document.createElement('button');optionalVehicle.id='vehicle-03';optionalVehicle.hidden=true;controls.append(optionalVehicle);
control('Проверить стартовую расстановку',async()=>{const r=await api('seed',{});notice('Расстановка сверена. Добавлено стартовых точек: '+r.added);await refresh()});
control('Ввести стартовые точки',async()=>{const src=prompt('Вставьте JSON точки или пакета организаторов');if(src){const rows=[].concat(await api('v1/track',JSON.parse(src)));notice('Применено '+rows.filter(r=>r.applied).length+' из '+rows.length);await refresh()}});
const simulatorInfo=document.createElement('p');
simulatorInfo.textContent='Координаты с itsim.geolaba.net принимаются постоянно. В симуляторе выключите локальный CORS-прокси.';
controls.append(simulatorInfo);
control('Другие источники GPS без ключа',async()=>{const enable=confirm('Открыть приём от других источников на час? Отмена закрывает их приём.');await api('competition-feed',{enable});notice(enable?'Другие источники GPS подключены на час':'Приём от других источников без ключа закрыт')});
control('Вернуть заявку в очередь',async()=>{const list=(await api('history')).filter(c=>!['pending','done'].includes(c.status));if(!list.length)return notice('Нет заявок для переназначения');const number=Number(prompt(list.map(c=>'№ '+c.number+' · '+labels[c.status]).join('\n')+'\nВведите номер'));if(!number)return;const reason=prompt('Причина решения старшего смены');if(reason){const started=list.find(c=>c.number===number)?.status==='working';if(started&&!confirm('Подтвердить снятие исполнителя с начатой работы?'))return;await api('control',{number,reason,confirmed:started});await refresh(number)}});
control('Загрузить выписку ATLB',async()=>{const src=prompt('Вставьте JSON-массив записей с полями ref, tail, ata, description, mel и until. Образец приведён в инструкции запуска.');if(src){const r=await api('atlb',{records:JSON.parse(src)});notice('Загружено записей ATLB: '+r.imported)}});
control('Ключ имитатора',async()=>{prompt('Authorization: Bearer <ключ>. POST /api/v1/track',(await api('track-key')).key)});
control('GPS телефона в машине',async()=>{const obj=prompt('ID спецтранспорта','vehicle-01');if(!obj)return;const b=await api('beacon',{obj});prompt('Откройте ссылку на телефоне в машине. Действует 12 часов.',location.origin+'/beacon#'+new URLSearchParams(b))});
control('Закрытые дороги',async()=>{const ids=prompt('ID закрытых участков через запятую. Пустое поле открывает дороги',(await api('roads')).join(','));if(ids!==null){await api('roads',{ids:ids.split(',').map(v=>v.trim()).filter(Boolean).map(Number)});await refresh()}});


let configUrl;
function clearPair(){
 if(configUrl)URL.revokeObjectURL(configUrl);
 configUrl=null;el('native-file').removeAttribute('href');el('native-pass').value='';
 el('native-pass').type='password';el('show-pass').textContent='Показать пароль';el('pair-info').hidden=true;
}
el('show-pass').onclick=()=>{
 const hidden=el('native-pass').type==='password';el('native-pass').type=hidden?'text':'password';
 el('show-pass').textContent=hidden?'Скрыть пароль':'Показать пароль';
};
el('pair').onclick=async()=>{
 el('pair').disabled=true;
 try{
  const {username,password,until}=await api('background-key',{});clearPair();
  const url=location.origin+'/api/owntracks';
  const settings={_type:'configuration',mode:3,auth:true,url,username,password,monitoring:2,locatorDisplacement:5,locatorInterval:10,moveModeLocatorInterval:10};
  configUrl=URL.createObjectURL(new Blob([JSON.stringify(settings)],{type:'application/json'}));
  el('native-file').href=configUrl;el('native-url').value=url;el('native-user').value=username;el('native-pass').value=password;
  el('pair-info').hidden=false;el('native-status').textContent='';
  el('valid-until').textContent='Доступ до '+new Date(until).toLocaleString('ru')+' или до выхода из смены. Новый пароль заменяет предыдущий.';
 }catch(e){notice(e.message)}finally{el('pair').disabled=false}
};
el('unpair').onclick=async()=>{
 try{await api('background-key',{revoke:true});clearPair();el('native-status').textContent='Фоновый доступ телефона отключён.'}catch(e){notice(e.message)}
};

el('mcc-intake').onsubmit=async ev=>{ev.preventDefault();try{await api('remarks',Object.fromEntries(new FormData(ev.target)));ev.target.reset();await refresh()}catch(e){notice(e.message)}};
