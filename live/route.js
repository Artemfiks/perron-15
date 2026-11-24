// Локальная метрическая проекция для небольшого конкурсного полигона.
let origin=[37.628,55.834];
export function setOrigin(bounds){origin=bounds.features[0].geometry.coordinates[0][0][0]}
export const xy = ([lon,lat]) => [(lon-origin[0])*111320*Math.cos(origin[1]*Math.PI/180),(origin[1]-lat)*111320];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function network(roads,mode='walk',closed=[],barriers=[]) {
  const polygons=barriers.flatMap(f=>f.geometry.coordinates.map(poly=>poly[0].map(xy)));
  function blocked(a,b){
    const cross=(p,q,r)=>(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);
    for(const ring of polygons){
      let inside=false;
      for(let i=1;i<ring.length;i++){
        const p=ring[i-1],q=ring[i];
        if((p[1]>a[1])!==(q[1]>a[1])&&a[0]<(q[0]-p[0])*(a[1]-p[1])/(q[1]-p[1])+p[0])inside=!inside;
        if(cross(a,b,p)*cross(a,b,q)<0&&cross(p,q,a)*cross(p,q,b)<0)return true;
      }
      if(inside)return true;
    }
    return false;
  }
  const nodes=[],index=new Map(),adj=[],edges=[];
  function node(p){
    const key=p.map(v=>Math.round(v*10)).join(',');
    if(!index.has(key)){index.set(key,nodes.length);nodes.push(p);adj.push([]);}
    return index.get(key);
  }
  for(const f of roads.features){
    if(closed.includes(f.properties.id)||!['pedestrian','service'].includes(f.properties.type)||(mode==='drive'&&f.properties.type!=='service'))continue;
    const speed=(mode==='drive'?Number(f.properties.spd_kmh):5)*1000/60;
    if(!(speed>0))continue;
    const ids=f.geometry.coordinates.map(p=>node(xy(p)));
    for(let i=1;i<ids.length;i++){
      const a=ids[i-1],b=ids[i],len=distance(nodes[a],nodes[b]);
      if(!len||blocked(nodes[a],nodes[b]))continue;
      const cost=len/speed;
      adj[a].push([b,cost]);adj[b].push([a,cost]);edges.push([a,b,len,cost]);
    }
  }
  function snap(p){
    let best;
    for(const [a,b,len,cost] of edges){
      const u=nodes[a],v=nodes[b],dx=v[0]-u[0],dy=v[1]-u[1];
      const t=Math.max(0,Math.min(1,((p[0]-u[0])*dx+(p[1]-u[1])*dy)/(len*len)));
      const q=[u[0]+t*dx,u[1]+t*dy], gap=distance(p,q);
      if(gap<=50&&(!best || gap<best.gap)&&!blocked(p,q))best={a,b,len,cost,t,q,gap};
    }
    return best;
  }
  function route(start,end){
    const s=snap(start),e=snap(end);
    if(!s||!e||s.gap>50 || e.gap>50)return null;
    const dist=nodes.map(()=>Infinity),prev=[],seen=new Set();
    dist[s.a]=s.t*s.cost;dist[s.b]=(1-s.t)*s.cost;
    for(;;){
      let u=-1,min=Infinity;
      for(let i=0;i<nodes.length;i++)if(!seen.has(i)&&dist[i]<min){min=dist[i];u=i;}
      if(u<0)break;
      seen.add(u);
      for(const [v,w] of adj[u])if(min+w<dist[v]){dist[v]=min+w;prev[v]=u;}
    }
    const da=dist[e.a]+e.t*e.cost,db=dist[e.b]+(1-e.t)*e.cost;
    let n=da<db?e.a:e.b,len=Math.min(da,db),path=[];
    if(s.a===e.a && s.b===e.b && Math.abs(s.t-e.t)*s.cost<=len){len=Math.abs(s.t-e.t)*s.cost;}
    else{if(!Number.isFinite(len))return null;while(n!==undefined){path.push(nodes[n]);n=prev[n];}path.reverse();}
    const full=[start,s.q,...path,e.q,end];
    const meters=full.slice(1).reduce((sum,p,i)=>sum+distance(p,full[i]),0);
    return {meters,minutes:len+(s.gap+e.gap)/(5000/60),path:full};
  }
  route.segments=edges.map(([a,b])=>[nodes[a],nodes[b]]);
  route.canJoin=p=>!!snap(p);
  return route;
}
export function center(feature){
 const ring=feature.geometry.coordinates[0][0].slice(0,-1).map(xy);
 return ring.reduce((p,q)=>[p[0]+q[0]/ring.length,p[1]+q[1]/ring.length],[0,0]);
}
