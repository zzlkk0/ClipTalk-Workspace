'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function initConfig(dataDir, port = 8000, tls) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  fs.mkdirSync(dataDir, {recursive:true,mode:0o700});
  for (const name of ['database','uploads']) fs.mkdirSync(path.join(dataDir,name),{recursive:true,mode:0o700});
  const filename=path.join(dataDir,'config.json');
  let config=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  config.port=port;
  if (!config.sessionSecret || config.sessionSecret === 'replace-with-a-random-session-secret') config.sessionSecret=crypto.randomBytes(32).toString('hex');
  config={maxLoginAttempts:5,loginWindowMinutes:15,rateLimitWindowMs:60000,rateLimitMax:100,...config};
  // HTTPS on the public port; the plain HTTP port then listens on loopback only.
  if (tls === null) delete config.https;
  else if (tls) {
    if (!Number.isInteger(tls.port) || tls.port < 1 || tls.port > 65535 || tls.port === port) throw new Error('Invalid HTTPS port');
    config.https={port:tls.port,cert:tls.cert,key:tls.key};
  }
  const temporary=filename+'.new-'+process.pid;
  fs.writeFileSync(temporary,JSON.stringify(config,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,filename);
  return filename;
}
if (require.main === module) {
  const dir=path.resolve(process.env.CLIPTALK_DATA_DIR || path.join(__dirname,'..'));
  const env=process.env;
  const tls=env.CLIPTALK_HTTPS_OFF==='1' ? null : env.CLIPTALK_HTTPS_PORT ? {port:Number(env.CLIPTALK_HTTPS_PORT),cert:env.CLIPTALK_TLS_CERT,key:env.CLIPTALK_TLS_KEY} : undefined;
  initConfig(dir,Number(env.CLIPTALK_PORT || 8000),tls);
  console.log('Application configuration is ready.');
}
module.exports={initConfig};
