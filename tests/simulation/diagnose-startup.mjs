import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
// Temporary CI probe: the normal simulation still runs against unmodified dependencies.
const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@getpaseo/cli-0-15-stable/package.json'));
const runtimeModule = join(dirname(cliRequire.resolve('@getpaseo/server/daemon-control')), '../terminal/terminal-worker-runtime.js');
async function probe(label, restore) {
const root = await mkdtemp(join(tmpdir(), 'Paseo CI worker 한글 '));
const home = join(root, 'paseo'), user = join(root, 'user');
for (const p of [home, join(home, 'terminal-worker'), user, join(user, 'AppData/Roaming'), join(user, 'AppData/Local')]) await mkdir(p, {recursive:true});
const env = {HOME:user, USERPROFILE:user, APPDATA:join(user,'AppData/Roaming'), LOCALAPPDATA:join(user,'AppData/Local'), TMPDIR:root,TMP:root,TEMP:root, PATH:dirname(process.execPath)+delimiter+(process.env.PATH??''), PASEO_HOME:home,PASEO_LISTEN:'127.0.0.1:0',PASEO_RELAY_ENABLED:'false'};
for (const name of ['SystemRoot','SYSTEMROOT','WINDIR','ComSpec','COMSPEC','PATHEXT','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','CLAUDE_CODE_GIT_BASH_PATH']) if(process.env[name]) env[name]=process.env[name];
for (const name of restore) if(process.env[name]) env[name]=process.env[name];
const {resolveTerminalWorkerEntry}=await import(pathToFileURL(runtimeModule));
const entry=resolveTerminalWorkerEntry({paseoHome:home,paseoVersion:'0.15.0'});
let source=await readFile(entry.scriptPath,'utf8');
source=source.replace('const self = await inspector.inspect(process.pid);', 'console.error("[DEBUG-ci015] inspect-start", Date.now()); const self = await inspector.inspect(process.pid); console.error("[DEBUG-ci015] inspect-end", Date.now(), self.status);');
source=source.replace('function reportReady(line) {','function reportReady(line) { console.error("[DEBUG-ci015] report-ready", Date.now());');
await writeFile(entry.scriptPath,source);
const started=Date.now();
const child=spawn(process.execPath,[entry.scriptPath,'--launch','--record-id',randomUUID(),'--paseo-home',home,'--paseo-version','0.15.0','--runtime',entry.runtime],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
console.log(JSON.stringify({label,restore,present:restore.filter(name=>process.env[name]!==undefined),platform:process.platform,node:process.version,code,elapsedMs:Date.now()-started,stdout,stderr}));
console.log('WORKER_LOG',await readFile(join(home,'terminal-worker.log'),'utf8').catch(()=>'<absent>'));
for (const f of await readdir(join(home,'terminal-worker'))) if(/^\d+\.json$/.test(f)) {const r=JSON.parse(await readFile(join(home,'terminal-worker',f)));try{process.kill(r.pid,'SIGKILL')}catch{}}
await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
await probe('control', []);
await probe('PowerShell module path', ['PSModulePath']);
await probe('Program Files', ['ProgramFiles']);
await probe('Program Data', ['ProgramData']);
await probe('system locations and identity', ['ALLUSERSPROFILE','ProgramData','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','PSModulePath','USERNAME','USERDOMAIN','PUBLIC','COMPUTERNAME','LOGONSERVER']);
await probe('control again', []);
// This probe records evidence; only the unmodified native simulation decides CI success.
