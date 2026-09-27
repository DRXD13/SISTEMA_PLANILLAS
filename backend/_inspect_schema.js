const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME
  });

  for (const t of ['historial_planillas', 'empleado_conceptos', 'parametros_sistema', 'conceptos']) {
    const [cols] = await conn.query(`DESCRIBE ${t}`);
    console.log(`\n--- ${t} ---`);
    console.log(cols.map(c => `${c.Field} (${c.Type})`).join(', '));
    const [count] = await conn.query(`SELECT COUNT(*) c FROM ${t}`);
    console.log('rows:', count[0].c);
  }
  const [sample] = await conn.query('SELECT * FROM historial_planillas LIMIT 3');
  console.log('\nSAMPLE historial_planillas:', JSON.stringify(sample, null, 2));

  await conn.end();
})();
