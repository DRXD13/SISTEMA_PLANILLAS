const bcrypt = require('bcryptjs');
const saltRounds = 10;
const plainPassword = '12345';

bcrypt.hash(plainPassword, saltRounds, function(err, hash) {
    if (err) {
        console.error(err);
    } else {
        console.log('El hash encriptado para "12345" es:');
        console.log(hash);
    }
});