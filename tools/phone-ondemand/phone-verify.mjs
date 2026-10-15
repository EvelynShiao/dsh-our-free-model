import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const src=path.join(process.env.DSH_HOME??path.join(os.homedir(),'.dsh'),'profiles/web/node_modules/dsh-our-free-model/src');
const bridge=await import(pathToFileURL(path.join(src,'opencode-bridge.js')));
if(typeof bridge.ensureService!=='function') throw new Error('Installed bridge is missing ensureService; restart/install state needs review.');
console.log('CLI detected:',bridge.hasOpencodeCli());
const running=await bridge.ensureService({autostart:false});
console.log('Service currently reachable:',Boolean(running));
if(!process.argv.includes('--chat')){
 console.log('Read-only check complete; no service start requested. Use --chat for one real free-model request.');
}else{
 const started=Date.now();
 const text=await bridge.bridgeStream({modelId:'mimo-v2.6-flash-free',prompt:'Reply with OK only. Do not use tools.',directory:os.homedir(),signal:AbortSignal.timeout(90000)});
 console.log('Chat result:',JSON.stringify(text.slice(0,200)),'elapsedMs:',Date.now()-started);
 console.log('Service remains running after this test. If not needed, run: opencode service stop');
}
