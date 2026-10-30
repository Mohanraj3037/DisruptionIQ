'use strict';
const crypto=require('node:crypto');
function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const N=32768,r=8,p=1;
  const maxmem=128*N*r*2;
  const hash=crypto.scryptSync(String(password),salt,64,{N,r,p,maxmem}).toString('hex');
  return `scrypt$${N}$${r}$${p}$${salt}$${hash}`;
}
module.exports={hashPassword};
