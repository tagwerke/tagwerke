import { connect } from './_db.ts';

const c = await connect();
const cols = await c.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('tabs','tasks') AND column_name IN ('user_id','project_id','position','starred','starred_position') ORDER BY 1,2`);
console.log('lingering dropped cols (expect none):', cols.rows.length ? cols.rows : 'NONE ✓');
const n = async (s: string) => (await c.query(s)).rows[0].n;
console.log('tabs :', await n('SELECT count(*)::int n FROM tabs'), ' tasks:', await n('SELECT count(*)::int n FROM tasks'), ' members:', await n('SELECT count(*)::int n FROM board_members'));
await c.end();
