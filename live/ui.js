import {xy,network,center} from './route.js';
import {aircraft,defects,priorities,describe} from './calls.mjs';
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
 if(user.role==='dispatcher'){
   const layers=await Promise.all(['roads','service_zones','objects','airport_boundaries'].map(async n=>(await fetch('/data/'+n)).json()));
   geo={roads:layers[0],zones:layers[1].features,objects:layers[2].features,bounds:layers[3].features};
   route=network(geo.roads);
   for(const model of aircraft)el('aircraft').add(new Option(model,model));
   for(const [id,info] of Object.entries(defects))el('defect').add(new Option(info.join(' · '),id));
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
    await api('point',{lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,time:p.timestamp});
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
function draw(team,zone){
 el('map').replaceChildren();
 function area(f,fill){for(const poly of f.geometry.coordinates)shape('polygon',{points:points(poly[0].map(xy)),fill,stroke:'#9aacb2','stroke-width':2});}
 geo.bounds.forEach(f=>area(f,'#f6f7ef'));geo.objects.forEach(f=>area(f,'#c6d3d8'));
 for(const road of geo.roads.features)shape('polyline',{points:points(road.geometry.coordinates.map(xy)),fill:'none',stroke:['service','pedestrian'].includes(road.properties.type)?'#9eb0b5':'#d1dadd','stroke-width':3});
 if(best)shape('polyline',{points:points(best.route.path),fill:'none',stroke:'#176b87','stroke-width':12,'stroke-linejoin':'round'});
 for(const z of geo.zones){
  const [x,y]=center(z);shape('circle',{cx:x,cy:y,r:22,fill:z===zone?'#edb02c':'#fff',stroke:'#7a919c','stroke-width':2});
  shape('text',{x,y:y+8,'font-size':23,'text-anchor':'middle'},String(z.properties.id));
 }
 for(const t of team)if(t.point && Date.now()-t.point.time<=60000){
  const [x,y]=xy([t.point.lon,t.point.lat]);shape('circle',{cx:x,cy:y,r:13,fill:'#168262',stroke:'white','stroke-width':3});
 }
}
async function refresh(prefer){
 const seq=++revision;
 try{
  if(account.role==='engineer'){
   const job=await api('job');if(seq!==revision)return;
   el('myjob').textContent=job?describe(job):'Ожидание назначения';el('done').hidden=!job;return;
  }
  const [team,calls]=await Promise.all([api('team'),api('calls')]);if(seq!==revision)return;
  const picker=el('pending');
  const current=calls.find(c=>c.number===(prefer??Number(picker.value)))??calls[0];
  picker.replaceChildren(...calls.map(c=>new Option('№ '+c.number+' · '+c.aircraft+' · зона '+c.zone+' · '+c.priority,c.number)));
  if(current)picker.value=String(current.number);
  else picker.add(new Option('Нет открытых вызовов',''));
  picker.disabled=!current;
  el('call-detail').textContent=current?describe(current):'Зафиксируйте вызов, чтобы подобрать инженера.';
  const zone=geo.zones.find(z=>z.properties.id===(current?.zone??Number(el('zone').value)));
  best=null;el('team').replaceChildren();
  for(const t of team){
   let status;
   const p=t.point;
   if(t.job)status='Назначен · '+describe(t.job);
   else if(!p)status='Ожидаем GPS';
   else if(Date.now()-p.time>60000)status='Координаты устарели';
   else if(p.accuracy>50)status='Низкая точность GPS';
   else if(!current)status='Свободен';
   else{
    const r=route(xy([p.lon,p.lat]),center(zone));
    if(!r)status='Вне доступной сети маршрутов';
    else{status=Math.round(r.meters)+' м · '+r.minutes.toFixed(1)+' мин'+(r.minutes>15?' · превышение 15 мин':'');if(!best || r.minutes<best.route.minutes)best={id:t.id,time:p.time,route:r,zone:zone.properties.id};}
   }
   const row=document.createElement('div'),detail=document.createElement('span');row.className='row';row.textContent=t.id;
   detail.textContent=status+(p?' · '+new Date(p.time).toLocaleTimeString('ru'):'');row.append(detail);el('team').append(row);
  }
  if(best)best.number=current.number;
  draw(team,zone);el('assign').disabled=!best;el('assign').textContent=best?'Назначить · '+best.id:'Назначить инженера';
 }catch(e){if(seq!==revision)return;best=null;el('assign').disabled=true;notice(e.message);}
}
el('zone').onchange=()=>{best=null;el('assign').disabled=true;refresh();};
el('pending').onchange=()=>{best=null;el('assign').disabled=true;refresh();};
el('call-form').onsubmit=async event=>{
 event.preventDefault();
 const button=event.currentTarget.querySelector('button');
 button.disabled=true;
 try{
  const call=await api('calls',{zone:Number(el('zone').value),aircraft:el('aircraft').value,tail:el('tail').value,defect:el('defect').value,priority:el('priority').value});
  notice('Вызов № '+call.number+' в очереди.');await refresh(call.number);
 }catch(e){notice(e.message);}finally{button.disabled=false;}
};
el('assign').onclick=async()=>{if(!best)return;const {id,time,zone,number}=best;el('assign').disabled=true;try{await api('assign',{id,time,zone,number});notice('Назначение отправлено инженеру.');}catch(e){notice(e.message);}await refresh();};
el('done').onclick=async()=>{try{await api('done',{});await refresh();}catch(e){notice(e.message);}};
api('me').then(load).catch(e=>notice(e.message));

