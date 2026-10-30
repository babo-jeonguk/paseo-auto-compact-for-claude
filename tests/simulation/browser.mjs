import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFixture, waitFor } from './fixture.mjs';
import { startModel } from './model.mjs';
const here=dirname(fileURLToPath(import.meta.url)), plugin=resolve(here,'../..');
const value=(name, fallback)=>{const at=process.argv.indexOf(name); return at<0 ? fallback : process.argv[at+1];};
const playwright=value('--playwright'), executablePath=value('--browser');
assert(playwright && executablePath, 'Specify --playwright /path/to/playwright-core/index.mjs and --browser /path/to/chromium');
const { chromium }=await import(pathToFileURL(resolve(playwright)));
const req=createRequire(join(plugin,'tests/simulation/package.json'));
const version=value('--paseo','0.12.0');
assert(['0.12.0','0.13.0','0.14.0'].includes(version), 'Unsupported Paseo version');
const alias=version.split('.').slice(0,2).join('-');
const reportDir=join(resolve(value('--report-dir',join(plugin,'test-results'))),`browser-${version}`);
await mkdir(reportDir,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'paseo-ui-validation-'));
const model=await startModel(); let fixture,browser;
const report={version, platform:process.platform, arch:process.arch, node:process.version, checks:[], sources:{}, startedAt:new Date().toISOString()};
try {
 for (const path of ['index.client.tsx','client/conversation.tsx','client/compact-submission.ts','client/conversations.tsx','client/format.ts','client/session-state.ts','client/settings.tsx','client/toggle.tsx','index.server.ts',
   'server/cache.ts','server/observer.ts','server/observer-source.mjs','server/observer-assets.generated.ts',
   'server/gateway.ts','server/scheduler.ts','server/model.ts','server/store.ts','server/operations.ts',
   'server/retention.ts','server/deadline.ts','shared/rpc.ts','shared/providers.ts','shared/settings.ts',
   'paseo-plugin.json','package.json','tests/simulation/fixture.mjs','tests/simulation/model.mjs','tests/simulation/browser.mjs']) {
   report.sources[path]=createHash('sha256').update(await readFile(join(plugin,path))).digest('hex');
 }
 fixture=await startFixture({root,plugin,cliPackage:req.resolve(`@getpaseo/cli-${alias}/package.json`),appVersion:version,binary:join(req.resolve(`@anthropic-ai/claude-code-${process.platform}-${process.arch}/package.json`),process.platform === 'win32' ? '../claude.exe' : '../claude'),model,reportDir,webUi:true});
 const id=await fixture.agent(); await fixture.turn(id,'UI_READY: reply without tools.');
 await waitFor(async()=> (await fixture.row(id)).status==='scheduled', 'UI reservation');
 browser=await chromium.launch({headless:true,executablePath:resolve(executablePath),args:['--no-sandbox']});
 report.chromium=browser.version();
 const page=await browser.newPage(); await page.goto('http://'+fixture.target,{waitUntil:'domcontentloaded'});
 await page.getByText('Auto Compact simulation',{exact:true}).first().click();
 await page.getByText('Compact in 55m',{exact:true}).first().click();
 await page.getByText('Skip this time',{exact:true}).click();
 await page.getByText('Undo skip',{exact:true}).waitFor();
 assert.equal((await fixture.row(id)).status,'skipped'); report.checks.push('Skip updates UI and daemon state');
 await page.getByText('Undo skip',{exact:true}).click();
 await waitFor(async()=> (await fixture.row(id)).status==='scheduled','UI undo');
 report.checks.push('Undo restores reservation');
 await page.getByText('Compact now',{exact:true}).click();
 await page.getByText('Confirm compact',{exact:true}).click();
 const completed=await waitFor(async()=>{const row=await fixture.row(id); return row.status==='completed' ? row : null;},'UI compact completion',60000);
 assert(completed.operationId); report.checks.push('Compact now completes through native session');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.getByText('Auto Compact simulation',{exact:true}).first().click();
 await page.getByText('Context manually compacted',{exact:true}).waitFor();
 await page.getByText('Compact on',{exact:true}).first().click();
 await page.getByText(/^Last compaction:/).waitFor();
 const body=await page.locator('body').innerText();
 assert.doesNotMatch(body, /Request status unconfirmed|compaction failed/i);
 report.finalBody=body; await page.screenshot({path:join(reportDir,'completed.png')});
 report.checks.push('Conversation remount after completion'); report.result='passed';
} catch(e) {report.result='failed'; report.error=String(e.stack??e); console.error(report.error); process.exitCode=1;}
finally {
 for (const cleanup of [()=>browser?.close(),()=>fixture?.close(),()=>model.close(),
   ()=>report.result==='passed' ? fixture?.remove() : undefined]) {
   try { await cleanup(); } catch(e) { report.cleanupError=String(e); report.result='failed'; process.exitCode=1; }
 }
 report.finishedAt=new Date().toISOString();
 await writeFile(join(reportDir,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.result.toUpperCase()}: ${report.checks.length} browser checks; ${join(reportDir,'report.json')}`);
}
