'use strict';
const fs=require('fs');
const path=require('path');
const {initConfig}=require('./scripts/init-config');
const dataDir=path.resolve(process.env.CLIPTALK_DATA_DIR||'/data');
process.env.CLIPTALK_DATA_DIR=dataDir;
initConfig(dataDir,Number(process.env.CLIPTALK_PORT||8000));
if(process.getuid?.()===0){
  function own(filename){
    const stat=fs.lstatSync(filename);
    if(stat.isSymbolicLink())return;
    if(stat.uid!==1000||stat.gid!==1000)fs.chownSync(filename,1000,1000);
    if(stat.isDirectory())for(const name of fs.readdirSync(filename))own(path.join(filename,name));
  }
  own(dataDir);process.setgid(1000);process.setuid(1000);
}
require('./server');
