'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function initConfig(dataDir, port = 8000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  fs.mkdirSync(dataDir, {recursive:true,mode:0o700});
  for (const name of ['database','uploads']) fs.mkdirSync(path.join(dataDir,name),{recursive:true,mode:0o700});
  const filename=path.join(dataDir,'config.json');
  let config=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  config.port=port;
  if (!config.sessionSecret || config.sessionSecret === 'replace-with-a-random-session-secret') config.sessionSecret=crypto.randomBytes(32).toString('hex');
  config={maxLoginAttempts:5,loginWindowMinutes:15,rateLimitWindowMs:60000,rateLimitMax:100,...config};
  const temporary=filename+'.new-'+process.pid;
  fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,filename);
  return filename;
}
if (require.main === module) {
  const dir=path.resolve(process.env.CLIPTALK_DATA_DIR || path.join(__dirname,'..'));
  initConfig(dir,Number(process.env.CLIPTALK_PORT || 8000));
  console.log('Application configuration is ready.');
}
module.exports={initConfig};
