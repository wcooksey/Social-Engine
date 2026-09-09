import { resolveJobGroup } from '../src/services/job-group';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import app from '../src/app';
import { prisma } from '../src/config/database';
import { signAccessToken } from '../src/utils/jwt';
import { groupFixture } from './helpers/group-fixture';
import { experimentScopeError } from '../src/services/experiment-scope';
import { executeTool } from '../src/engine/tools';

// Opt in explicitly: never run database fixtures against the normal app database.
const enabled = process.env.GROUP_WORKSPACE_TEST_DB === '1';
let f: Awaited<ReturnType<typeof groupFixture>>, server: Server, base: string, token: string;
before(async () => {
  if (!enabled) return;
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only an isolated localhost database is allowed');
  f = await groupFixture();
  token = signAccessToken({ userId:f.user.id, organizationId:f.org.id, email:f.user.email, role:'OWNER', tv:0 });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async () => {
  if (!enabled) return;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (f) await prisma.organization.deleteMany({ where: { id: { in:[f.org.id, f.otherOrg.id] } } });
  await prisma.$disconnect();
});
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(base + path, { headers: { Authorization:'Bearer ' + token, 'Content-Type':'application/json' }, ...(body === undefined ? {} : {method, body:JSON.stringify(body)}) });
  return {status:response.status, ...(await response.json())};
}
const it = (name:string, fn:()=>Promise<void>) => test(name, {skip:!enabled}, fn);
it('inbox combines group, search and pagination without mixing another group', async () => {
  const a=await request(`/api/conversations?groupId=${f.a.id}&search=Sample`);
  assert.equal(a.data.total,1); assert.equal(a.data.conversations[0].id,f.conversation.id);
  assert.equal(a.data.conversations[0].lead.group.id,f.a.id);
  assert.equal((await request(`/api/conversations?groupId=${f.b.id}&search=Motors`)).data.total,0);
  assert.equal((await request('/api/conversations?groupId=ungrouped')).data.total,1);
  assert.equal((await request(`/api/conversations?groupId=${f.foreign.id}`)).status,404);
});
it('shared campaigns appear by enrollment while detail rows stay group scoped', async () => {
  const b=await request(`/api/campaigns?groupId=${f.b.id}`);
  assert.deepEqual(b.data.map((c:any)=>c.id),[f.campaign.id]);
  const detail=await request(`/api/campaigns/${f.campaign.id}?groupId=${f.b.id}`);
  assert.deepEqual(detail.data.campaignLeads.map((r:any)=>r.lead.id),[f.leadB.id]);
  assert.equal((await request(`/api/campaigns/${f.sequence.id}?groupId=${f.b.id}`)).status,404);
  assert.equal((await request(`/api/leads/${f.leadA.id}?groupId=${f.b.id}`)).status,404);
});
it('applicable playbooks include shared rules but exclude another group', async () => {
  const result=await request(`/api/playbooks?groupId=${f.a.id}`);
  assert.ok(result.data.some((p:any)=>p.name==='Shared reply rules'));
  assert.ok(result.data.some((p:any)=>p.id===f.pb.id));
  assert.ok(!result.data.some((p:any)=>p.id===f.otherPb.id));
});
it('new chats keep group context without a playbook and reject a mismatched playbook', async () => {
  const created=await request('/api/engine/chats',{groupId:f.b.id});
  assert.equal(created.status,201); assert.equal(created.data.groupId,f.b.id); assert.equal(created.data.playbookId,null);
  assert.equal((await request('/api/engine/chats',{groupId:f.a.id,playbookId:f.otherPb.id})).status,400);
  assert.equal((await request(`/api/engine/chats/${f.chat.id}`,{playbookId:f.otherPb.id},'PATCH')).status,400);
  const list=await request(`/api/engine/chats?groupId=${f.b.id}`);
  assert.ok(!list.data.some((c:any)=>c.id===f.chat.id));
});
it('message provenance carries real relations and leaves legacy data honestly empty', async () => {
  const detail=await request(`/api/conversations/${f.conversation.id}?groupId=${f.a.id}`);
  const message=detail.data.messages[0];
  assert.equal(message.campaign.id,f.campaign.id); assert.equal(message.experimentVariant.experiment.id,f.experiment.id);
  assert.equal(message.provenance.playbookName,f.pb.name);
  assert.equal((await request(`/api/conversations/${f.conversation.id}?groupId=${f.b.id}`)).status,404);
  assert.equal((await request(`/api/conversations/${f.legacy.id}`)).data.messages[0].provenance,null);
});
it('experiment creation validates group ownership and rejects fixed sequence targets', async () => {
  const input={name:'Fixture comparison',channel:'EMAIL',groupId:f.a.id,variants:[{label:'A',content:'A'},{label:'B',content:'B'}]};
  assert.equal((await request('/api/experiments',{...input,groupId:f.foreign.id})).status,404);
  assert.equal((await request('/api/experiments',{...input,campaignId:f.sequence.id})).status,400);
  const created=await request('/api/experiments',{...input,campaignId:f.campaign.id});
  assert.equal(created.data.groupId,f.a.id); assert.equal(created.data.campaignId,f.campaign.id);
  const list=await request(`/api/experiments?groupId=${f.a.id}`);
  assert.ok(!list.data.some((e:any)=>e.name==='Freight-only test'));
});
it('sandbox rejects a lead outside its group before any LLM run, while preview is read-only', async () => {
  const before=await prisma.agentRun.count({where:{organizationId:f.org.id}});
  assert.equal((await request('/api/sandbox/reply',{groupId:f.a.id,leadId:f.leadB.id,channel:'EMAIL',message:'Hello'})).status,404);
  assert.equal(await prisma.agentRun.count({where:{organizationId:f.org.id}}),before);
  const messages=await prisma.message.count();
  const result=await request(`/api/campaigns/${f.sequence.id}/preview?leadId=${f.leadA.id}`);
  assert.equal(result.status,200); assert.equal(result.data.subject,'A short introduction');
  assert.ok(result.data.blockers.length); assert.equal(await prisma.message.count(),messages);
});
it('group live excludes other and unassigned runs', async () => {
  const a=await request(`/api/agent/live?groupId=${f.a.id}`), b=await request(`/api/agent/live?groupId=${f.b.id}`);
  assert.equal(a.data.recentFinished.length,1); assert.equal(b.data.recentFinished.length,0);
});
it('simulated sends never reach CRM writes; variant mismatch is refused before sending', async () => {
  const before=await prisma.message.count();
  const result:any=await executeTool('send_email',{leadId:f.leadA.id,body:'Preview only',subject:'Preview'}, {organizationId:f.org.id,runId:'fixture',simulate:true});
  assert.equal(result.simulated,true); assert.equal(await prisma.message.count(),before);
  const mismatch:any=await executeTool('send_email',{leadId:f.leadB.id,experimentVariantId:f.experiment.variants[0].id,body:'Never send',subject:'Never send'}, {organizationId:f.org.id,runId:'fixture'});
  assert.match(mismatch.reason,/another group/); assert.equal(await prisma.message.count(),before);
});
test('variant scope rejects wrong tenant, group, campaign, channel and paused experiments',()=>{
  const e={organizationId:'org',groupId:'a',campaignId:'c',channel:'EMAIL',status:'ACTIVE'};
  const c={organizationId:'org',groupId:'a',campaignId:'c',channel:'EMAIL'};
  assert.equal(experimentScopeError(e,c),null);
  for(const change of [{organizationId:'other'},{groupId:'b'},{campaignId:'other'},{channel:'SMS'}]) assert.ok(experimentScopeError(e,{...c,...change}));
  assert.ok(experimentScopeError({...e,status:'PAUSED'},c));
});

it('a campaign spanning groups never becomes a single-group Engine job', async () => {
  const job = { organizationId:f.org.id, leadId:null, campaignId:f.campaign.id, playbookId:f.pb.id, createdByRunId:null };
  assert.equal(await resolveJobGroup(job),undefined);
  assert.equal(await resolveJobGroup({...job,campaignId:f.sequence.id}),f.a.id);
  assert.equal(await resolveJobGroup({...job,leadId:f.leadB.id}),f.b.id);
});

it('campaign settings persist across enrolled groups without activation or sequence changes', async () => {
  const result = await request(`/api/campaigns/${f.campaign.id}`, { name: 'Updated local campaign', offer: 'Updated offer', mode: 'APPROVAL_REQUIRED', followUpCadenceDays: 5, maxTouches: 4, reEngageAfterDays: 30, maxCycles: 2 }, 'PATCH');
  assert.equal(result.status, 200);
  for (const group of [f.a, f.b]) {
    const saved = (await request(`/api/campaigns/${f.campaign.id}?groupId=${group.id}`)).data;
    assert.equal(saved.name, 'Updated local campaign'); assert.equal(saved.followUpCadenceDays, 5);
    assert.equal(saved.maxCycles, 2); assert.equal(saved.reEngageAfterDays, 30); assert.equal(saved.status, 'PAUSED');
  }
  assert.equal((await request(`/api/campaigns/${f.campaign.id}`, { followUpCadenceDays: 0 }, 'PATCH')).status, 400);
  assert.equal((await request(`/api/campaigns/${f.campaign.id}`, { mode: 'INVALID' }, 'PATCH')).status, 400);
  assert.equal((await request(`/api/campaigns/${f.sequence.id}`, { reEngageAfterDays: 30 }, 'PATCH')).status, 400);
  const fixed = await request(`/api/campaigns/${f.sequence.id}`, { name: 'Fixed local campaign', mode: 'APPROVAL_REQUIRED', maxTouches: 9 }, 'PATCH');
  assert.equal(fixed.status, 200); assert.equal(fixed.data.status, 'DRAFT'); assert.deepEqual(fixed.data.sequenceSteps, f.sequence.sequenceSteps); assert.equal(fixed.data.maxTouches, f.sequence.maxTouches);
});
it('quiet hours persist at organization scope and reject invalid hour values', async () => {
  const foreign = await prisma.organization.findUniqueOrThrow({ where: { id: f.otherOrg.id } });
  assert.equal((await request('/api/organizations/mine', { quietHoursStart: 21, quietHoursEnd: 9 }, 'PATCH')).status, 200);
  const saved = (await request('/api/organizations/mine')).data;
  assert.equal(saved.quietHoursStart, 21); assert.equal(saved.quietHoursEnd, 9); assert.equal(saved.paused, true);
  for (const value of [-1, 24, 8.5, '20:30', null]) assert.equal((await request('/api/organizations/mine', { quietHoursStart: value }, 'PATCH')).status, 400);
  const untouched = await prisma.organization.findUniqueOrThrow({ where: { id: f.otherOrg.id } });
  assert.equal(untouched.quietHoursStart, foreign.quietHoursStart); assert.equal(untouched.quietHoursEnd, foreign.quietHoursEnd);
});
