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
 if(!res.ok){if(res.status===401 && account)location.reload();throw Error(result.error);}
 return result;
}
async function load(user){
 account=user;
 for(const [id,show] of [['entry',!user],['engineer',user?.role==='engineer'],['dispatch',user?.role==='dispatcher'],['logout',!!user]])el(id).hidden=!show;
 if(!user)return;
 el('identity').textContent=user.id;
 {
   const layers=await Promise.all(['roads','service_zones','objects','airport_boundaries'].map(async n=>(await fetch('/data/'+n)).json()));
   geo={roads:layers[0],zones:layers[1].features,objects:layers[2].features,bounds:layers[3].features};
   const site=await (await fetch('/site.json')).json();geo.barriers=forbiddenObjects(geo.objects,site.blockedObjects);
   setOrigin(layers[3]);document.querySelector('.maphead span').textContent=geo.zones.length+' зон';document.querySelector('.maphead h2').textContent=site.name;
   if(user.role==='engineer')el('engineer').append(document.querySelector('.mapbox'));
   for(const model of aircraft)el('aircraft').add(new Option(model,model));
   Object.assign(defects,await api('catalog'));filterDefects();
   for(const [id,name] of Object.entries(priorities))el('priority').add(new Option(name,id));
   el('priority').value='B';
   for(const z of geo.zones)el('zone').add(new Option('Зона обслуживания '+z.properties.id,z.properties.id));
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
 if(label)n.textContent=label;el('map').append(n);return n;
}
const points=coords=>coords.map(p=>p.join(',')).join(' ');
function updateRoads(closed){
 const key=JSON.stringify(closed);
 if(geo.closureKey===key)return;
 geo.closureKey=key;geo.closed=closed;
 geo.walk=network(geo.roads,'walk',closed,geo.barriers);
}
let lastMap;
el('focus').onchange=()=>{if(lastMap)draw(...lastMap)};
function draw(team,zone){
 lastMap=[team,zone];
 const map=el('map'),focus=el('focus'),engineers=team.filter(t=>t.kind==='engineer');
 const selected=focus.value;
 if([...focus.options].slice(1).map(o=>o.value).join('|')!==engineers.map(t=>t.obj).join('|')){
  focus.replaceChildren(new Option('Весь полигон',''),...engineers.map(t=>new Option(t.id,t.obj)));
  focus.value=selected || (account.role==='engineer'?account.obj:'');
 }
 map.replaceChildren();
 const hatch=shape('pattern',{id:'restricted',patternUnits:'userSpaceOnUse',width:12,height:12});
 hatch.append(shape('rect',{width:12,height:12,fill:'#ffe1d8'}),shape('path',{d:'M-2 2L2 -2M0 12L12 0M10 14L14 10',stroke:'#c65b47','stroke-width':2}));
 const defs=shape('defs',{});defs.append(hatch);
 function area(f,fill,stroke,width){
  const d=f.geometry.coordinates.flatMap(poly=>poly.map(ring=>'M'+ring.map(p=>xy(p).join(',')).join('L')+'Z')).join(' ');
  shape('path',{d,fill,stroke,'fill-rule':'evenodd','stroke-width':width});
 }
 geo.bounds.forEach(f=>area(f,'#fbfaf0','#85989c',2));
 geo.objects.filter(f=>!geo.barriers.includes(f)).forEach(f=>area(f,'#d7dfe1','#9daeb2',2));
 for(const road of geo.roads.features){
  const closed=geo.closed.includes(road.properties.id);
  shape('polyline',{points:points(road.geometry.coordinates.map(xy)),fill:'none',stroke:closed?'#624956':'#c9d1cf','stroke-width':closed?4:2,'stroke-dasharray':closed?'8 6':'none'});
 }
 shape('path',{d:geo.walk.segments.map(([a,b])=>'M'+a+'L'+b).join(' '),fill:'none',stroke:'#278257','stroke-width':4,'stroke-linecap':'round'});
 geo.barriers.forEach(f=>area(f,'url(#restricted)','#a83229',3));
 if(best)shape('polyline',{points:points(best.route.path),fill:'none',stroke:'#176b87','stroke-width':7,'stroke-linejoin':'round'});
 for(const t of team)if(t.job?.route&&!t.job.arrivedAt)shape('polyline',{points:points(t.job.route.path),fill:'none',stroke:'#176b87','stroke-width':7});
 const focused=engineers.find(t=>t.obj===focus.value)?.point;
 const zoom=focused&&Date.now()-focused.time<=60000;
 const all=geo.bounds.flatMap(f=>f.geometry.coordinates.flat(2).map(xy)),xs=all.map(p=>p[0]),ys=all.map(p=>p[1]);
 let box=[Math.min(...xs)-45,Math.min(...ys)-45,Math.max(...xs)-Math.min(...xs)+90,Math.max(...ys)-Math.min(...ys)+90];
 if(zoom){const [x,y]=xy([focused.lon,focused.lat]);box=[x-140,y-140,280,280]}
 map.setAttribute('viewBox',box.join(' '));
 function label(x,y,title,size,anchor='middle'){
  shape('text',{x,y,'font-size':size,'text-anchor':anchor,fill:'#19343d',stroke:'white','stroke-width':size/5,'paint-order':'stroke'},title);
 }
 for(const f of geo.objects){const [x,y]=center(f);label(x,y,f.properties.name,zoom?8:17)}
 for(const z of geo.zones){
  const [x,y]=center(z),r=zoom?6:16;shape('circle',{cx:x,cy:y,r,fill:z===zone?'#edb02c':'#fff',stroke:'#71828a','stroke-width':1.5});
  label(x,y+r*.4,String(z.properties.id),r*1.1);
 }
 const colors={blocked:'#a92b24',uncertain:'#986000',unknown:'#596b76',outside:'#535867',open:'#145c40'};
 el('positions').replaceChildren();
 for(const t of team){
  const p=t.point,isEngineer=t.kind==='engineer';
  const info=isEngineer?positionStatus(p,geo.barriers,geo.bounds,geo.walk):null;
  const color=info?colors[info.level]:(t.kind==='aircraft'?'#963c61':'#324e99');
  if(isEngineer){
   const row=document.createElement('div'),title=document.createElement('strong'),status=document.createElement('span');
   row.className='positionrow';row.style.borderLeftColor=color;title.textContent=t.id;status.textContent=info.text;row.append(title,status);
   if(p){const stamp=document.createElement('small');stamp.textContent='GPS '+new Date(p.time).toLocaleTimeString('ru')+' · ±'+Math.round(p.accuracy)+' м';row.append(stamp)}
   el('positions').append(row);
  }
  if(!p||Date.now()-p.time>60000)continue;
  const [x,y]=xy([p.lon,p.lat]),r=zoom?3.5:10;
  if(isEngineer)shape('circle',{cx:x,cy:y,r:p.accuracy,fill:color,'fill-opacity':.12,stroke:color,'stroke-width':zoom?1:2,'stroke-dasharray':'3 3'});
  shape('circle',{cx:x,cy:y,r,fill:color,stroke:'#fff','stroke-width':zoom?1:2});
  label(x+r+2,y-r,t.id,zoom?7:17,'start');
 }
}
function timing(f){
 const seconds=Math.ceil(Math.abs(f.marginMs)/1000);
 return 'ETA '+new Date(f.eta).toLocaleTimeString('ru')+' · '+(f.inTime?'запас ':'опоздание ')+Math.floor(seconds/60)+' мин '+seconds%60+' с';
}
async function refresh(prefer){
 const seq=++revision;
 try{
  if(account.role==='engineer'){
   const [job,visible,closed]=await Promise.all([api('job'),api('agents'),api('roads')]);if(seq!==revision)return;updateRoads(closed);
   activeJob=job;
   el('myjob').textContent=job?[describe(job),labels[job.status],job.arrivedAt?'Прибытие '+new Date(job.arrivedAt).toLocaleTimeString()+' · '+(job.inLimit?'в нормативе':'с опозданием'):job.route?'До зоны '+job.route.minutes.toFixed(1)+' мин':'Ожидание GPS'].join(' · '):'Ожидание назначения';
   if(job){el('myjob').textContent+=(job.kit?' · Комплект '+(job.kitCollected?'получен':'получить на складе'):'')+(job.route?' · '+job.route.mode:'')+(job.aircraftNear?' · Рядом ВС '+job.aircraftNear:'');}
   best=job?.route?{route:job.route}:null;
   draw(visible,geo.zones.find(z=>z.properties.id===job?.zone));
   const buttons=el('actions');buttons.replaceChildren();
   if(job?.kit){const tool=document.createElement('button');tool.textContent=job.kitCollected?'Отметить отсутствие комплекта':'Подтвердить наличие комплекта';tool.onclick=async()=>{try{await api('tool',{number:job.number,collected:!job.kitCollected});await refresh()}catch(e){notice(e.message)}};buttons.append(tool)}
   if(job?.status==='working'){
    const decision=document.createElement('button');decision.textContent='AOG / отложить по MEL';decision.onclick=async()=>{
     const value=prompt('AOG или категория MEL A/B/C/D');if(!value)return;
     const until=value==='AOG'?null:prompt('Срок отложения в формате ГГГГ-ММ-ДДTчч:мм');
     try{await api('decision',{number:job.number,decision:value.toUpperCase(),until:until?new Date(until).toISOString():null});await refresh()}catch(e){notice(e.message)}
    };buttons.append(decision);
    if(job.melHistory?.length)buttons.append(document.createTextNode('Предыдущие MEL: '+job.melHistory.map(h=>h.mel+' до '+h.until).join(', ')));
   }
   const actions={assigned:[['accept','Принять'],['reject','Отклонить']],arrived:[['start','Начать работы']],working:[['done','Завершить работы'],['wait','Ожидать запчасть']]};
   for(const [action,title] of actions[job?.status]||[]){const btn=document.createElement('button');btn.textContent=title;btn.onclick=async()=>{btn.disabled=true;try{await api('action',{action,number:job.number});await refresh()}catch(e){notice(e.message)}};buttons.append(btn)}
   return;
  }
  const [team,calls,agents,remarks,closed]=await Promise.all([api('team'),api('calls'),api('agents'),api('remarks'),api('roads')]);if(seq!==revision)return;updateRoads(closed);
  const selected=el('remark').value;el('remark').replaceChildren(new Option('Регистрация вручную',''),...remarks.map(r=>new Option(r.author+' · '+r.note,r.id)));if(remarks.some(r=>r.id===selected))el('remark').value=selected;
  const picker=el('pending');
  const current=calls.find(c=>c.number===(prefer??Number(picker.value)))??calls[0];
  picker.replaceChildren(...calls.map(c=>new Option('№ '+c.number+' · '+c.aircraft+' · зона '+c.zone+' · '+c.priority,c.number)));
  if(current)picker.value=String(current.number);
  else picker.add(new Option('Нет открытых вызовов',''));
  picker.disabled=!current;
  el('call-detail').textContent=current?describe(current):'Зафиксируйте вызов, чтобы подобрать инженера.';
  const zone=geo.zones.find(z=>z.properties.id===(current?.zone??Number(el('zone').value)));
  best=null;el('team').replaceChildren();
  const ranking=current?await api('rank?number='+current.number):[];if(seq!==revision)return;
  for(const t of team){
   let status;
   const p=t.point;
   if(t.job)status=[describe(t.job),labels[t.job.status],t.job.arrivedAt?'Факт '+new Date(t.job.arrivedAt).toLocaleTimeString():t.job.eta?'ETA '+new Date(t.job.eta).toLocaleTimeString():'Нет свежего прогноза',t.job.risk?'Риск срыва: проверьте свободных инженеров и переназначение':''].filter(Boolean).join(' · ');
   else if(!p)status='Ожидаем GPS';
   else if(Date.now()-p.time>60000)status='Координаты устарели';
   else if(p.accuracy>50)status='Низкая точность GPS';
   else if(!current)status='Свободен';
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
     if(candidate.id===ranking[0]?.id)best={id:t.id,time:candidate.time,route:r,zone:zone.properties.id};
    }
   }
   if(t.job?.risk){
    const alt=t.job.alternate;
    status+=' · Срок '+new Date(t.job.createdAt+900000).toLocaleTimeString('ru');
    if(!alt)status+=' · Свободной подходящей замены нет';
    else status+=(alt.inTime?' · Успевает замена: ':' · Ни одна свободная замена не успевает. Быстрейшая: ')+alt.id+', '+timing(alt);
   }
   if(t.job&&!t.job.arrivedAt)status+=' · До норматива '+Math.max(0,Math.ceil((t.job.createdAt+900000-Date.now())/1000))+' с';
   if(t.job?.aircraftNear)status+=' · Рядом ВС '+t.job.aircraftNear;
   const row=document.createElement('div'),detail=document.createElement('span');row.className='row';row.textContent=t.id;
   detail.textContent=status+(p?' · '+new Date(p.time).toLocaleTimeString('ru'):'');row.append(detail);el('team').append(row);
  }
  if(best)best.number=current.number;
  draw(agents.map(a=>({...a,job:team.find(t=>t.id===a.id)?.job})),zone);el('assign').disabled=!best;el('assign').textContent=best?'Назначить · '+best.id:'Назначить инженера';
 }catch(e){if(seq!==revision)return;best=null;el('assign').disabled=true;notice(e.message);}
}
el('zone').onchange=()=>{best=null;el('assign').disabled=true;refresh();};
el('pending').onchange=()=>{best=null;el('assign').disabled=true;refresh();};
el('call-form').onsubmit=async event=>{
 event.preventDefault();
 const button=event.currentTarget.querySelector('button');
 button.disabled=true;
 try{
  const call=await api('calls',{zone:Number(el('zone').value),aircraft:el('aircraft').value,tail:el('tail').value,defect:el('defect').value,priority:el('priority').value,text:el('custom').value,ata:Number(el('ata').value),kit:el('kit').checked,source:el('source').value,remarkId:el('remark').value,scheduled:el('scheduled').value?new Date(el('scheduled').value).toISOString():null});
  if(el('custom').value.trim())defects[call.defect]=[el('custom').value.trim(),'ATA '+call.ata];
  if(el('custom').value.trim()){if(!Array.from(el('defect').options).some(o=>o.value===call.defect))el('defect').add(new Option(call.description,call.defect));el('defect').value=call.defect;el('custom').value='';}
  notice('Вызов № '+call.number+' в очереди.');await refresh(call.number);
 }catch(e){notice(e.message);}finally{button.disabled=false;}
};
el('assign').onclick=async()=>{if(!best)return;const {id,time,zone,number}=best;el('assign').disabled=true;try{await api('assign',{id,time,zone,number});notice('Назначение отправлено инженеру.');}catch(e){notice(e.message);}await refresh();};
el('done').replaceWith(Object.assign(document.createElement('div'),{id:'actions'}));
api('me').then(load).catch(e=>notice(e.message));
const controls=document.createElement('article');controls.innerHTML='<h2>Управление сменой</h2><p><a href="/api/log.csv">Скачать журнал CSV</a></p>';
el('dispatch').append(controls);
function control(title,fn){const b=document.createElement('button');b.textContent=title;b.onclick=()=>fn().catch(e=>notice(e.message));controls.append(b)}
function filterDefects(){const q=el('lookup').value.trim().toLowerCase();el('defect').replaceChildren(...Object.entries(defects).filter(([k,v])=>(k+' '+v.join(' ')).toLowerCase().includes(q)).map(([k,v])=>new Option(v.join(' · '),k)))}
el('lookup').oninput=filterDefects;
const report=document.createElement('button');report.textContent='Передать замечание в MCC/ЦПУ';report.onclick=async()=>{const note=prompt('Опишите обнаруженную проблему');if(note)try{await api('remarks',{note});notice('Замечание поступило диспетчеру')}catch(e){notice(e.message)}};el('engineer').append(report);
control('Показатели смены',async()=>{const m=await api('metrics'),v=n=>n===null?'—':n.toFixed(1);notice('Всего '+m.registered+' · без прибытия '+m.withoutArrival+' · в нормативе '+m.onTime+' из '+m.arrived+' ('+v(m.arrived?100*m.onTime/m.arrived:null)+'%) · среднее прибытие '+v(m.meanSeconds)+' с · средняя ошибка первого ETA '+v(m.meanEtaErrorSeconds)+' с · подбор '+v(m.meanSelectionMs)+' мс')});
control('Ввести стартовые точки',async()=>{const src=prompt('Вставьте JSON точки или пакета организаторов');if(src){const rows=[].concat(await api('v1/track',JSON.parse(src)));notice('Применено '+rows.filter(r=>r.applied).length+' из '+rows.length);await refresh()}});
control('Приём имитатора без ключа',async()=>{const enable=confirm('Открыть приём GPS без ключа на один час? Отмена закрывает приём.');await api('competition-feed',{enable});notice(enable?'Вход для имитатора открыт на один час':'Вход без ключа закрыт')});
control('Вернуть заявку в очередь',async()=>{const list=(await api('history')).filter(c=>!['pending','done'].includes(c.status));if(!list.length)return notice('Нет заявок для переназначения');const number=Number(prompt(list.map(c=>'№ '+c.number+' · '+labels[c.status]).join('\n')+'\nВведите номер'));if(!number)return;const reason=prompt('Причина решения старшего смены');if(reason){await api('control',{number,reason});await refresh(number)}});
control('Ключ имитатора',async()=>{prompt('Authorization: Bearer <ключ>. POST /api/v1/track',(await api('track-key')).key)});
control('GPS телефона в машине',async()=>{const obj=prompt('ID спецтранспорта','v-01');if(!obj)return;const b=await api('beacon',{obj});prompt('Откройте ссылку на телефоне в машине. Действует 12 часов.',location.origin+'/beacon#'+new URLSearchParams(b))});
control('Состав и допуски',async()=>{const obj=prompt('ID агента (например e-01, v-01 или RA-73142)');if(!obj)return;const kind=prompt('Тип: engineer, vehicle, aircraft','engineer');if(!kind)return;const at=kind==='engineer'?prompt('Главы ATA через запятую','79,34'):'';if(at===null)return;const models=kind==='engineer'?prompt('Типы ВС через запятую',aircraft.join(',')):null;if(kind==='engineer'&&models===null)return;const result=await api('roster',{obj,kind,models:models?.split(',').map(m=>m.trim()),ata:at.split(',').filter(Boolean).map(Number)});if(result.code)prompt('Код нового инженера',result.code);else notice('Параметры агента сохранены');});
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
