const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const site=path.join(__dirname,'../live'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'perron-ui-'));
 const output=process.argv[2];if(!output)throw Error('Укажите папку для результатов');fs.mkdirSync(output,{recursive:true});
 const server=spawn(process.execPath,['server.mjs'],{cwd:site,env:{...process.env,SHIFT_PROFILE:'training',HOST:'127.0.0.1',PORT:'0',STATE_DB:path.join(tmp,'ui.db'),RENDER:'test',DISPATCH_CODE:'local-dispatch',ENGINEER_ONE_CODE:'local-engineer',ENGINEER_TWO_CODE:'local-second',TRACK_KEY:'local-feed'},stdio:['ignore','pipe','inherit']});
 let browser;try{
 const [chunk]=await once(server.stdout,'data'),origin=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0];
 browser=await chromium.launch({channel:'msedge',headless:true});
 const zones=JSON.parse(fs.readFileSync(path.join(site,'data/service_zones.geojson'))).features;
 function pos(i){const ring=zones[i].geometry.coordinates[0][0].slice(0,-1);return {latitude:ring.reduce((s,p)=>s+p[1],0)/ring.length,longitude:ring.reduce((s,p)=>s+p[0],0)/ring.length,accuracy:4}}
 const desktop=await browser.newContext({viewport:{width:1440,height:940}}),mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,geolocation:pos(1),permissions:['geolocation']});
 const d=await desktop.newPage(),e=await mobile.newPage(),errors=[];for(const page of [d,e])page.on('pageerror',err=>errors.push(String(err)));
 async function enter(page,role,code){await page.goto(origin);await page.locator('#login [value="'+role+'"]').check();await page.locator('#code').fill(code);await page.getByRole('button',{name:'Войти'}).click();await page.locator('#logout').waitFor()}
 await Promise.all([enter(d,'dispatcher','local-dispatch'),enter(e,'engineer','local-engineer')]);
 const mobileB=await browser.newContext({viewport:{width:390,height:844},isMobile:true,geolocation:pos(5),permissions:['geolocation']});
 const e2=await mobileB.newPage();e2.on('pageerror',err=>errors.push(String(err)));await enter(e2,'engineer','local-second');
 const post=(ctx,url,data)=>ctx.request.post(origin+'/api/'+url,{data});
 const issued=await (await post(desktop,'staff-code',{role:'mcc'})).json();
 const office=await browser.newContext(),m=await office.newPage();await enter(m,'dispatcher',issued.code);
 await m.locator('[name=note]').fill('Экипаж сообщает об отказе навигации');await m.getByText('Записать сообщение',{exact:true}).click();
 await m.getByRole('button',{name:/Проверить и передать/}).click();
 await d.locator('#remark option').filter({hasText:'Экипаж сообщает'}).waitFor({state:'attached'});
 await d.locator('#remark').selectOption({index:1});
 assert.equal((await post(office,'decision',{number:1,decision:'AOG'})).status(),403);
 assert.equal((await post(office,'assign',{number:1,engineer:'Инженер 1'})).status(),403);
 const feed=async data=>desktop.request.post(origin+'/api/v1/track',{data,headers:{Authorization:'Bearer local-feed'}});
 const loc=pos(3),p=obj=>({obj,lon:loc.longitude,lat:loc.latitude,acc:4});
 const ids=['e-02','v-01','RA-73142','unknown'];
 const batch=await (await feed({points:ids.map(p)})).json();
 assert.deepEqual(batch.map(r=>[r.obj,r.accepted,r.applied]),ids.map((id,i)=>[id,true,i!==3]));
 const prev=await (await desktop.request.get(origin+'/api/agents')).json();
 const outlier=await (await feed({...p('v-01'),acc:800})).json();assert.equal(outlier.applied,false);
 for(const data of [{obj:'v-01',lon:1},{obj:'v-01',lat:'0',lon:1}])assert.equal((await feed(data)).status(),400);
 const next=await (await desktop.request.get(origin+'/api/agents')).json();
 for(const id of ids.slice(0,3)){const q=next.find(a=>a.obj===id).point;assert.equal(q.lat,loc.latitude);assert.equal(q.lon,loc.longitude)}
 assert.deepEqual(prev.find(a=>a.obj==='v-01').point,next.find(a=>a.obj==='v-01').point);
 for(const label of ['Инженер 2','RA-73142','Автомобиль 1'])await d.locator('#map').getByText(label,{exact:true}).waitFor();
 await desktop.request.post(origin+'/api/roster',{data:{obj:'e-02',kind:'engineer',ata:[34]}});
 await feed({...p('e-01'),t:new Date(Date.now()-70000).toISOString()});
 await d.locator('#positions').getByText(/Последняя известная позиция/).waitFor();
 await mobile.setGeolocation(pos(1));await mobileB.setGeolocation(pos(5));
 for(const page of [e,e2]){await page.locator('#track').click();await page.getByText(/Передано в/).waitFor()}
 await mobile.setOffline(true);await e.locator('#busy-minutes').fill('2');await e.getByRole('button',{name:'Указать время'}).click();await e.locator('#sync').getByText(/Ожидает отправки/).waitFor();await mobile.setOffline(false);await e.locator('#availability-status').getByText(/Занят до/).waitFor();
 await d.locator('#zone').selectOption(String(zones[5].properties.id));await d.locator('#defect').selectOption('NAV');
 await d.locator('#scheduled').fill('2026-12-03T12:00');await d.locator('#tail').fill('ТЕСТ-01');
 await d.getByRole('button',{name:'Зафиксировать вызов'}).click();
 await e2.getByRole('button',{name:'Отклонить',exact:true}).waitFor();
 await e.getByRole('button',{name:'Я свободен'}).click();await e2.getByRole('button',{name:'Отклонить',exact:true}).click();
 await e.getByRole('button',{name:'Принять',exact:true}).click();await e.getByText(/В пути/).waitFor();
 await d.locator('#offer-history').getByText(/Инженер 2.*Отклонено/).waitFor();
 await d.locator('#offer-history').getByText(/Инженер 1.*Принято/).waitFor();
 await d.locator('#map .chosen-route').first().waitFor({state:'attached'});
 await e.locator('#map .chosen-route').first().waitFor({state:'attached'});
 await d.locator('#offer-history').locator('..').screenshot({path:path.join(output,'Диспетчер.png')});
 await e.locator('#myjob').locator('..').screenshot({path:path.join(output,'Инженер.png')});
 await mobile.setGeolocation(pos(5));
 await e.getByRole('button',{name:'Начать работы',exact:true}).click();await e.getByRole('button',{name:'Завершить работы',exact:true}).click();
 await d.locator('#call-detail').getByText(/Выполнено.*в нормативе/).waitFor();
 const csv=await (await desktop.request.get(origin+'/api/log.csv')).text();assert(csv.includes('offer-rejected')&&csv.includes('arrival'));
 fs.writeFileSync(path.join(output,'Журнал.csv'),csv);
 const metrics=await (await desktop.request.get(origin+'/api/metrics')).json();
 fs.writeFileSync(path.join(output,'Показатели.json'),JSON.stringify({metrics,batch,outlier},null,2));
 assert.equal(metrics.arrived,1);assert.equal(metrics.registered,1);
 assert.equal(csv.split('\r\n').filter(row=>row.includes('"availability"')&&row.includes('""minutes"":2,')).length||csv.split('\r\n').filter(row=>row.includes('"availability"')&&row.includes('""minutes"":2}')).length,1);
 assert.deepEqual(errors,[]);console.log('Browser verified: busy minutes, automatic offer, rejection, forwarding, accepted route on both maps, GPS arrival, completion and CSV');
 }finally{if(browser)await browser.close();const done=once(server,'exit');server.kill();await done;fs.rmSync(tmp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
