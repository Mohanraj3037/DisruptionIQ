'use strict';
const crypto = require('node:crypto');
const { get, run, nowIso } = require('./database');
function sha256(value){ return crypto.createHash('sha256').update(value).digest('hex'); }
const {hashPassword}=require('./password');
function safeHexEqual(a,b){
  try{const x=Buffer.from(a,'hex'),y=Buffer.from(b,'hex');return x.length===y.length&&crypto.timingSafeEqual(x,y);}catch{return false;}
}
function verifyPassword(password,encoded){
  if(!encoded||typeof encoded!=='string')return false;
  try{
    // Native format used by the migrated Node backend.
    let m=encoded.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([a-f0-9]+)$/i);
    if(m){const [,N,r,p,salt,expected]=m;const actual=crypto.scryptSync(String(password),salt,expected.length/2,{N:Number(N),r:Number(r),p:Number(p),maxmem:128*Number(N)*Number(r)*2}).toString('hex');return safeHexEqual(actual,expected);}
    // Werkzeug 3.x default: scrypt:32768:8:1$salt$hex
    m=encoded.match(/^scrypt:(\d+):(\d+):(\d+)\$([^$]+)\$([a-f0-9]+)$/i);
    if(m){const [,N,r,p,salt,expected]=m;const actual=crypto.scryptSync(String(password),salt,expected.length/2,{N:Number(N),r:Number(r),p:Number(p),maxmem:128*Number(N)*Number(r)*2}).toString('hex');return safeHexEqual(actual,expected);}
    // Werkzeug PBKDF2: pbkdf2:sha256:iterations$salt$hex
    m=encoded.match(/^pbkdf2:(sha1|sha256|sha512):(\d+)\$([^$]+)\$([a-f0-9]+)$/i);
    if(m){const [,digest,iterations,salt,expected]=m;const actual=crypto.pbkdf2Sync(String(password),salt,Number(iterations),expected.length/2,digest).toString('hex');return safeHexEqual(actual,expected);}
    return false;
  }catch{return false;}
}
function cookieMap(header=''){
  return Object.fromEntries(header.split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1))];}));
}
function createSession(userId,{remember=false}={}){
  const token=crypto.randomBytes(32).toString('base64url');
  const csrf=crypto.randomBytes(24).toString('base64url');
  const maxAgeSeconds=remember?30*24*60*60:8*60*60;
  const expires=new Date(Date.now()+maxAgeSeconds*1000).toISOString();
  run(`INSERT INTO sessions(token_hash,csrf_token,user_id,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)`,sha256(token),csrf,userId,expires,nowIso(),nowIso());
  return {token,csrf,expires,maxAgeSeconds};
}
function getSessionFromRequest(req){
  const cookies=cookieMap(req.headers.cookie||'');
  const token=cookies.diq_session;
  if(!token)return null;
  const session=get(`SELECT s.*,u.username,u.email,u.full_name,u.role,u.is_active,u.customer_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`,sha256(token));
  if(!session||session.is_active!==1||new Date(session.expires_at).getTime()<Date.now()){
    if(session)run('DELETE FROM sessions WHERE id=?',session.id);
    return null;
  }
  run('UPDATE sessions SET last_seen_at=? WHERE id=?',nowIso(),session.id);
  return {id:session.id,user:{id:session.user_id,username:session.username,email:session.email,name:session.full_name||session.username,role:session.role,customer_id:session.customer_id||null,initials:(session.full_name||session.username).split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()},csrfToken:session.csrf_token,expires:session.expires_at,token};
}
function destroySession(req){const c=cookieMap(req.headers.cookie||'');if(c.diq_session)run('DELETE FROM sessions WHERE token_hash=?',sha256(c.diq_session));}
const INTERNAL_ROLES=new Set(['HUB_INCHARGE','RISK_ANALYST','RECOVERY_MANAGER']);
function canAccess(user,...roles){
  if(!user||user.role==='CUSTOMER')return false;
  // Existing HUB_INCHARGE checks are the common employee-workspace gate.
  if(roles.includes('HUB_INCHARGE'))return INTERNAL_ROLES.has(user.role);
  return roles.includes(user.role);
}
function verifyCsrf(req,session){
  if(!session)return false;
  const header=req.headers['x-csrf-token'];
  const origin=req.headers.origin;
  const host=req.headers.host;
  if(origin){try{const u=new URL(origin);if(u.host!==host)return false;}catch{return false;}}
  return typeof header==='string'&&header===session.csrfToken;
}
module.exports={hashPassword,verifyPassword,createSession,getSessionFromRequest,destroySession,canAccess,verifyCsrf,cookieMap};
