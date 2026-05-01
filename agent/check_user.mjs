import mysql from 'mysql2/promise';
import crypto from 'crypto';

async function main() {
  // Try localhost
  let conn;
  try {
    conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'Joseph1991@',
      database: 'rangerai',
      socketPath: '/var/run/mysqld/mysqld.sock'
    });
  } catch (e1) {
    try {
      conn = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'root',
        password: 'Joseph1991@',
        database: 'rangerai'
      });
    } catch (e2) {
      // Try without password
      try {
        conn = await mysql.createConnection({
          host: '127.0.0.1',
          user: 'root',
          database: 'rangerai'
        });
      } catch (e3) {
        console.error('All connection attempts failed:', e1.message, '|', e2.message, '|', e3.message);
        process.exit(1);
      }
    }
  }
  
  console.log('Connected to MySQL!');
  
  // Query jianwufy user
  const [rows] = await conn.execute(
    'SELECT id, username, displayName, role, isActive, salt, passwordHash FROM users WHERE username = ?',
    ['jianwufy']
  );
  
  if (rows.length === 0) {
    console.log('User jianwufy NOT FOUND');
    // List all users
    const [allUsers] = await conn.execute('SELECT id, username, displayName, role, isActive FROM users');
    console.log('All users:', JSON.stringify(allUsers, null, 2));
  } else {
    const user = rows[0];
    console.log('User found:', JSON.stringify({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      isActive: user.isActive,
      saltLen: user.salt?.length,
      hashLen: user.passwordHash?.length
    }, null, 2));
    
    // Verify password Joseph1991@
    const testPassword = 'Joseph1991@';
    const derived = await new Promise((resolve, reject) => {
      crypto.scrypt(testPassword, user.salt, 64, (err, key) => {
        if (err) reject(err);
        else resolve(key.toString('hex'));
      });
    });
    
    const match = derived === user.passwordHash;
    console.log(`Password 'Joseph1991@' matches: ${match}`);
    
    if (!match) {
      console.log('Expected hash:', user.passwordHash.substring(0, 30) + '...');
      console.log('Got hash:     ', derived.substring(0, 30) + '...');
    }
  }
  
  await conn.end();
}

main().catch(e => console.error(e));
