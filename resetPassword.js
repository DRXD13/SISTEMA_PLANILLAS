const bcrypt = require('bcrypt');
const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '2025', // Tu contraseña de MySQL
  database: 'sistema_planilla'
});

const username = 'admin';         // Usuario que quieras resetear
const newPassword = '12345';      // Nueva contraseña que usarás para login

bcrypt.hash(newPassword, 10, (err, hash) => {
  if (err) throw err;
  db.query('UPDATE usuarios SET password = ? WHERE username = ?', [hash, username], (err) => {
    if (err) throw err;
    console.log(`Contraseña actualizada para ${username}. Usa la nueva contraseña: ${newPassword}`);
    db.end();
  });
});
