// Локальная метрическая проекция для небольшого конкурсного полигона.
export const xy = ([lon,lat]) => [(lon-37.628)*62500,(55.834-lat)*111320];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export function network(roads) {
  const nodes=[],index=new Map(),adj=[],edges=[];
  function node(p){
    const key=p.map(v=>Math.round(v*10)).join(',');
    if(!index.has(key)){index.set(key,nodes.length);nodes.push(p);adj.push([]);}
    return index.get(key);
  }
  for(const f of roads.features){
    if(!['pedestrian','service'].includes(f.properties.type))continue;
    const ids=f.geometry.coordinates.map(p=>node(xy(p)));
    for(let i=1;i<ids.length;i++){
      const a=ids[i-1],b=ids[i],len=distance(nodes[a],nodes[b]);
      if(!len)continue;
      adj[a].push([b,len]);adj[b].push([a,len]);edges.push([a,b,len]);
    }
  }
  function snap(p){
    let best;
    for(const [a,b,len] of edges){
      const u=nodes[a],v=nodes[b],dx=v[0]-u[0],dy=v[1]-u[1];
      const t=Math.max(0,Math.min(1,((p[0]-u[0])*dx+(p[1]-u[1])*dy)/(len*len)));
      const q=[u[0]+t*dx,u[1]+t*dy], gap=distance(p,q);
      if(!best || gap<best.gap)best={a,b,len,t,q,gap};
    }
    return best;
  }
  return (start,end)=>{
    const s=snap(start),e=snap(end);
    if(s.gap>50 || e.gap>50)return null;
    const dist=nodes.map(()=>Infinity),prev=[],seen=new Set();
    dist[s.a]=s.t*s.len;dist[s.b]=(1-s.t)*s.len;
    for(;;){
      let u=-1,min=Infinity;
      for(let i=0;i<nodes.length;i++)if(!seen.has(i)&&dist[i]<min){min=dist[i];u=i;}
      if(u<0)break;
      seen.add(u);
      for(const [v,w] of adj[u])if(min+w<dist[v]){dist[v]=min+w;prev[v]=u;}
    }
    const da=dist[e.a]+e.t*e.len,db=dist[e.b]+(1-e.t)*e.len;
    let n=da<db?e.a:e.b,len=Math.min(da,db),path=[];
    if(s.a===e.a && s.b===e.b && Math.abs(s.t-e.t)*s.len<=len){len=Math.abs(s.t-e.t)*s.len;}
    else{if(!Number.isFinite(len))return null;while(n!==undefined){path.push(nodes[n]);n=prev[n];}path.reverse();}
    const meters=len+s.gap+e.gap;
    return {meters,minutes:2+meters/(5000/60),path:[start,s.q,...path,e.q,end]};
  };
}
export function center(feature){
 const ring=feature.geometry.coordinates[0][0].slice(0,-1).map(xy);
 return ring.reduce((p,q)=>[p[0]+q[0]/ring.length,p[1]+q[1]/ring.length],[0,0]);
}
