import {DatabaseSync} from 'node:sqlite';
export function journal(file){
 const db=new DatabaseSync(file);db.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, t TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, ticket INTEGER, detail TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
 CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'append only'); END;
 CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, json TEXT NOT NULL);`);
 db.exec("CREATE TABLE IF NOT EXISTS metadata(k TEXT PRIMARY KEY,v TEXT); INSERT OR IGNORE INTO metadata VALUES('shift',hex(randomblob(16)))");
 const shiftId=db.prepare("SELECT v FROM metadata WHERE k='shift'").get().v;
 const ins=db.prepare('INSERT INTO events(t,kind,actor,ticket,detail) VALUES(?,?,?,?,?)');
 const save=db.prepare('INSERT OR REPLACE INTO state VALUES(1,?)');
 function record(kind,actor,c,detail={},snapshot){
  db.exec('BEGIN IMMEDIATE');try{
   ins.run(new Date().toISOString(),kind,actor||'',c?.number??null,JSON.stringify(detail));
   if(snapshot)save.run(JSON.stringify(snapshot));db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
 }
 const receipts=db.prepare("SELECT 1 FROM events WHERE actor=? AND json_extract(detail,'$.requestId')=? LIMIT 1");
 db.exec("CREATE INDEX IF NOT EXISTS event_receipt ON events(actor,json_extract(detail,'$.requestId'))");
 const received=(actor,id)=>!!receipts.get(actor,id);
 const quote=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
 function csv(){const all=db.prepare('SELECT * FROM events ORDER BY seq').all();return '\uFEFF'+'seq,time_utc,event,actor,call,parameters\r\n'+all.map(r=>Object.values(r).map(quote).join(',')).join('\r\n')}
 function metrics(){
  const arrivals=new Map(),forecasts=new Map(),registered=new Set(),selection=[];
  for(const e of db.prepare("SELECT kind,ticket,detail FROM events WHERE kind IN ('registered','assigned','arrival','candidates') ORDER BY seq").iterate()){
   const d=JSON.parse(e.detail);
   if(e.kind==='registered')registered.add(e.ticket);
   if(e.kind==='assigned'&&!forecasts.has(e.ticket))forecasts.set(e.ticket,d.forecast);
   if(e.kind==='arrival'&&!arrivals.has(e.ticket))arrivals.set(e.ticket,{...d,forecast:forecasts.get(e.ticket)});
   if(e.kind==='candidates')selection.push(d.durationMs);
  }
  const rows=[...arrivals.values()],mean=list=>list.length?list.reduce((s,x)=>s+x,0)/list.length:null;
  return {registered:registered.size,arrived:rows.length,withoutArrival:registered.size-rows.length,
   onTime:rows.filter(r=>r.inLimit).length,meanSeconds:mean(rows.map(r=>r.elapsedSeconds)),
   meanEtaErrorSeconds:mean(rows.filter(r=>Number.isFinite(r.forecast)).map(r=>Math.abs(r.arrivedAt-r.forecast)/1000)),
   meanSelectionMs:mean(selection)};
 }
 return {shiftId,record,received,csv,metrics,restore:()=>JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get()?.json||'null'),close:()=>db.close()};
}
