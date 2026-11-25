import {readFileSync} from 'node:fs';

const layers=[
 ['aircrafts_positions','aircraft','object_id'],
 ['engineers_positions','engineer','tabel_id'],
 ['service_vehicles_positions','vehicle','object_id']
];
// Scenario permissions, editable by the dispatcher. The archive itself lists scopes, not ATA numbers.
const chapters={ME:[29,32,53,79],AV:[23,24,34],Cabbin:[25,33]};
export function officialLineup(){
 const agents=[],seen=new Set();
 for(const [name,kind,key] of layers){
  const layer=JSON.parse(readFileSync(new URL('./data/'+name+'.geojson',import.meta.url)));
  for(const feature of layer.features){
   const fields=feature.properties,obj=fields[key],coords=feature.geometry.coordinates;
   if(!obj||seen.has(obj)||feature.geometry.type!=='Point'||coords.length!==2||!coords.every(Number.isFinite))throw Error('Некорректная стартовая точка '+obj);
   seen.add(obj);
   agents.push({id:obj,obj,kind,official:fields,initial:coords,
    ...(kind==='engineer'?{ata:fields.skill==='AM'?[]:chapters[fields.scope]||[]}:{}),
    ...(obj==='vehicle-03'?{enabled:false}:{})});
  }
 }
 return agents;
}
export function seedPositions(agents,points){
 let count=0;
 for(const a of agents){
  if(!a.initial||points.has(a.id))continue;
  const [lon,lat]=a.initial;
  points.set(a.id,{obj:a.obj,lon,lat,time:0,accuracy:0,source:'start'});count++;
 }
 return count;
}
