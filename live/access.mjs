import {xy} from './route.js';
import {insideZone} from './lifecycle.mjs';

export const forbiddenObjects=(objects,ids)=>objects.filter(f=>f.properties.forbidden===true || ids.includes(f.properties.id));

function edgeDistance(point,feature){
 let nearest=Infinity;
 for(const polygon of feature.geometry.coordinates)for(const ring of polygon){
  for(let i=1;i<ring.length;i++){
   const [x,y]=xy(ring[i-1]),[u,v]=xy(ring[i]);
   const dx=u-x,dy=v-y;
   const t=Math.min(1,Math.max(0,((point[0]-x)*dx+(point[1]-y)*dy)/(dx*dx+dy*dy||1)));
   nearest=Math.min(nearest,Math.hypot(point[0]-x-t*dx,point[1]-y-t*dy));
  }
 }
 return nearest;
}

export function positionStatus(point,barriers,bounds,walk,now=Date.now()){
 if(!point)return {level:'unknown',text:'Ожидаем первую GPS-точку'};
 if(now-point.time>60000)return {level:'unknown',text:'Последняя известная позиция · GPS устарел'};
 if(point.accuracy>50)return {level:'uncertain',text:'Низкая точность GPS · положение относительно контура неизвестно'};
 const coords=[point.lon,point.lat],p=xy(coords);
 for(const f of barriers){
  const name='«'+f.properties.name+'»';
  if(edgeDistance(p,f)<=point.accuracy)return {level:'uncertain',text:'У границы '+name+' · точности GPS недостаточно, чтобы определить сторону'};
  if(insideZone(coords,f))return {level:'blocked',text:'Проход запрещён · GPS внутри контура '+name};
 }
 if(bounds.some(f=>edgeDistance(p,f)<=point.accuracy))return {level:'uncertain',text:'У границы полигона · положение неоднозначно'};
 if(!bounds.some(f=>insideZone(coords,f)))return {level:'outside',text:'За пределами полигона'};
 if(walk.canJoin(p))return {level:'open',text:'Вне запретных контуров · есть подход к открытой дорожке'};
 return {level:'outside',text:'Вне запретных контуров · открытая дорожка недоступна в пределах 50 м'};
}
