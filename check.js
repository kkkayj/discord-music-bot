require('dotenv').config();
const t = process.env.TOKEN || '';
console.log('TOKEN length   :', t.length);
console.log('Starts with    :', t.substring(0, 4));
console.log('Dot count      :', (t.match(/\./g) || []).length);
console.log('Has spaces     :', t.includes(' '));
console.log('Has quotes     :', t.includes('"') || t.includes("'"));
console.log('CLIENT_ID len  :', (process.env.CLIENT_ID || '').length);
