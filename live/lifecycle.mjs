const transitions={assigned:{accept:'enroute',reject:'pending'},enroute:{arrive:'arrived'},arrived:{start:'working'},working:{done:'done',wait:'waiting'}};
export const labels={pending:'В очереди',assigned:'Назначен',enroute:'В пути',arrived:'Прибыл',working:'В работе',done:'Выполнено',waiting:'Ожидание запчасти'};
export function transition(call,action,time){
 const status=transitions[call?.status]?.[action];
 if(!status)throw Object.assign(Error('Действие недоступно на текущем этапе'),{status:409});
 call.status=status;
 if(action==='accept')call.acceptedAt=time;
 if(action==='arrive'){call.arrivedAt=time;call.inLimit=time-call.createdAt<=900000;}
 if(action==='done')call.completedAt=time;
 return status;
}
function insideRing([x,y],ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
 const [a,b]=ring[i],[c,d]=ring[j];
 if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)inside=!inside;
}return inside}
export const insideZone=(point,feature)=>feature.geometry.coordinates.some(poly=>insideRing(point,poly[0])&&!poly.slice(1).some(r=>insideRing(point,r)));
