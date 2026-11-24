const chapterNames=new Map([
 [23,'Связь'],[24,'Электропитание'],[29,'Гидросистема'],[32,'Шасси'],
 [33,'Освещение'],[34,'Навигация'],[53,'Фюзеляж'],[79,'Масляная система двигателя']
]);
const byId=id=>document.getElementById(id);
const sorted=list=>[...list].sort((a,b)=>a-b);

export function rosterEditor(api,refresh,aircraft,defects){
 const form=byId('roster-panel'),person=byId('roster-person'),kind=byId('roster-kind');
 const chapterList=byId('chapter-list'),models=byId('roster-models'),status=byId('roster-status');
 const save=byId('roster-save'),number=byId('chapter-number');
 let people=[],baseline,dirty=false,saving=false;
 const isNew=()=>person.value==='+';
 const qualifications=a=>({ata:sorted(a?.ata??[]),models:[...(a?.models??aircraft)].sort()});
 const checked=(container)=>Array.from(container.querySelectorAll('input:checked'),i=>i.value);
 function markDirty(){
  dirty=true;status.textContent='Есть несохранённые изменения';save.disabled=saving;
  byId('chapter-count').textContent='Выбрано '+checked(chapterList).length;
 }
 function option(container,value,label,detail,selected){
  const tile=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');
  input.type='checkbox';input.value=value;input.checked=selected;
  const name=document.createElement('b');name.textContent=label;text.append(name);
  if(detail){const caption=document.createElement('span');caption.textContent=detail;text.append(caption)}
  tile.append(input,text);container.append(tile);return input;
 }
 function show(message=''){
  const agent=people.find(a=>a.obj===person.value);
  baseline=qualifications(agent);dirty=false;
  byId('roster-new').hidden=!isNew();byId('roster-id').required=isNew();byId('roster-id').value='';
  byId('roster-code').hidden=true;byId('new-engineer-code').value='';
  kind.value='engineer';byId('roster-qualifications').hidden=false;
  const chapters=new Set([...chapterNames.keys(),...baseline.ata]);
  for(const a of people)for(const n of a.ata||[])chapters.add(n);
  for(const [,ata] of Object.values(defects)){const n=Number(ata.split(' ')[1]);if(n>0&&n<100)chapters.add(n)}
  chapterList.replaceChildren();models.replaceChildren();
  for(const n of sorted(chapters))option(chapterList,n,'ATA '+String(n).padStart(2,'0'),chapterNames.get(n)||'Дополнительная глава',baseline.ata.includes(n));
  for(const model of aircraft)option(models,model,model,'',baseline.models.includes(model));
  number.value='';byId('chapter-count').textContent='Выбрано '+baseline.ata.length;
  save.textContent=isNew()?'Добавить участника':'Сохранить допуски';
  save.disabled=saving||!isNew();status.textContent=message;
 }
 function update(agents){
  people=agents.filter(a=>a.kind==='engineer');
  const ids=people.map(a=>a.obj);
  if(JSON.stringify(ids)!==JSON.stringify(Array.from(person.options,o=>o.value).filter(k=>k!=='+'))||!person.options.length){
   const selected=person.value;
   person.replaceChildren(...people.map(a=>new Option(a.id+' · '+a.obj,a.obj)),new Option('+ Добавить участника','+'));
   if(selected==='+'||ids.includes(selected))person.value=selected;
   if(!baseline||person.value!==selected)show();
  }
  if(!dirty&&!saving&&!isNew()&&JSON.stringify(baseline)!==JSON.stringify(qualifications(people.find(a=>a.obj===person.value))))show();
 }
 person.onchange=()=>show();
 kind.onchange=()=>{byId('roster-qualifications').hidden=kind.value!=='engineer';markDirty()};
 chapterList.onchange=models.onchange=byId('roster-id').oninput=markDirty;
 function addChapter(){
  const n=number.valueAsNumber;
  if(!Number.isInteger(n)||n<1||n>99){number.setCustomValidity('Введите номер главы от 1 до 99');number.reportValidity();return}
  let input=chapterList.querySelector('input[value="'+n+'"]');
  if(!input)input=option(chapterList,n,'ATA '+String(n).padStart(2,'0'),'Дополнительная глава',true);
  input.checked=true;number.value='';input.focus();markDirty();
 }
 byId('chapter-add').onclick=addChapter;
 number.oninput=()=>number.setCustomValidity('');
 number.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addChapter()}};
 form.onsubmit=async e=>{
  e.preventDefault();if(saving)return;
  const creating=isNew(),obj=creating?byId('roster-id').value.trim():person.value;
  const type=creating?kind.value:'engineer';
  if(creating&&!/^[-\w]{1,32}$/.test(obj)){status.textContent='Для ID используйте 1–32 латинские буквы, цифры, дефис или подчёркивание.';return}
  if(type==='engineer'&&number.value){addChapter();if(number.value)return}
  const data={obj,kind:type,ata:type==='engineer'?sorted(checked(chapterList).map(Number)):[]};
  if(type==='engineer')data.models=checked(models);
  if(creating)data.createOnly=true;else data.previous=baseline;
  saving=true;save.disabled=true;form.inert=true;status.textContent='Сохранение…';
  try{
   const result=await api('roster',data);await refresh();
   if(type==='engineer'&&people.some(a=>a.obj===obj))person.value=obj;
   show(creating?'Участник добавлен':'Допуски сохранены');
   if(result.code){byId('new-engineer-code').value=result.code;byId('roster-code').hidden=false;}
  }catch(err){status.textContent=err.message}
  finally{saving=false;form.inert=false;save.disabled=!dirty&&!isNew()}
 };
 return {update};
}
