'use strict';
const {get,run,nowIso}=require('../src/database');
const {hashPassword}=require('../src/security');
const username=String(process.env.CREATE_HUB_USERNAME||'').trim();
const email=String(process.env.CREATE_HUB_EMAIL||'').trim().toLowerCase();
const fullName=String(process.env.CREATE_HUB_NAME||username).trim();
const password=String(process.env.CREATE_HUB_PASSWORD||'');
if(!username||!email||!password||password.length<12){
 console.error('Set CREATE_HUB_USERNAME, CREATE_HUB_EMAIL, CREATE_HUB_NAME and CREATE_HUB_PASSWORD (minimum 12 characters).');process.exit(1);
}
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){console.error('CREATE_HUB_EMAIL must be a valid email address.');process.exit(1);}
if(get('SELECT id FROM users WHERE username=? OR email=?',username,email)){console.error('A user with this username or email already exists. No account was changed.');process.exit(1);}
const now=nowIso();const result=run('INSERT INTO users(username,email,password_hash,role,customer_id,full_name,is_active,created_at) VALUES(?,?,?,\'HUB_INCHARGE\',NULL,?,1,?)',username,email,hashPassword(password),fullName,now);
console.log(`Created independent HUB_INCHARGE account ID ${Number(result.lastInsertRowid)} (${username}). Password was not printed.`);
