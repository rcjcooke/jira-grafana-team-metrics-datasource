import connect, {sql} from '@databases/pg';
import { config } from 'dotenv';

config();

const db = connect();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on('connect', () => {
  console.log('connected to the db');
});

export async function get(id) {
    const [row] = await db.query(
      sql`
        SELECT data
        FROM my_data
        WHERE id=${id}
      `
    );
    return row ? row.data : null;
  }

export async function set(id, value) {
await db.query(sql`
    INSERT INTO cache_data (id, data)
    VALUES (${id}, ${value})
    ON CONFLICT id
    DO UPDATE SET data = EXCLUDED.data;
`);
}