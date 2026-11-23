import test from 'node:test';import assert from 'node:assert/strict';import {journal} from '../journal.mjs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
test('Журнал после перезапуска: CSV, миллисекунды, защита изменения',()=>{
 const file=join(mkdtempSync(join(tmpdir(),'perron-check-')),'test.sqlite');const j=journal(file);
 j.record('assigned','E1',{number:3},{durationMs:0.5},{calls:[3]});j.close();
 const k=journal(file);assert.deepEqual(k.restore(),{calls:[3]});assert.match(k.csv(),/\.\d{3}Z/);assert.match(k.csv(),/durationMs/);
 const db=new DatabaseSync(file);assert.throws(()=>db.exec('DELETE FROM events'),/append only/);db.close();k.close();
});
