import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { csvCell, crmInput } from '../src/services/crm.service';
import { previewCrmImport } from '../src/services/crm-import.service';
import { prisma } from '../src/config/database';
import app from '../src/app';
import { signAccessToken } from '../src/utils/jwt';
import type { Server } from 'http';

test('CSV escapes formulas, commas, quotes and line breaks', () => {
  assert.equal(csvCell(' =HYPERLINK("x")'), '"\' =HYPERLINK(""x"")"');
  assert.equal(csvCell('A,"B"\nC'), '"A,""B""\nC"');
  assert.equal(csvCell('+1234'), '"\'+1234"');
});
test('call validation rejects missing outcomes and invalid stages', () => {
  assert.throws(() => crmInput({kind:'CALL',requestId:randomUUID(),note:''}));
  assert.throws(() => crmInput({kind:'NOTE',requestId:randomUUID(),note:'note',stage:'ADMIN'}));
  assert.equal(crmInput({kind:'CALL',requestId:randomUUID(),note:'',outcome:'DO_NOT_CONTACT'}).stage,'DO_NOT_CONTACT');
});
test('CSV preview validates structure and handles exported phone escapes and quoted names', () => {
  const preview = previewCrmImport('\uFEFFCompany,Contact,Company phone,Email,Calls\r\n"Acme, Inc.","Pat ""PJ"" Smith",\'+15555550100,pat@example.test,99\r\n');
  assert.equal(preview.records[0].companyName, 'Acme, Inc.');
  assert.equal(preview.records[0].contactName, 'Pat "PJ" Smith');
  assert.equal(preview.records[0].phone, '+15555550100');
  assert.deepEqual(preview.ignoredColumns, ['Calls']);
  for (const csv of ['Company,Email\n"Unclosed,a@b.test', 'Company,Email\nA,a@b.test,extra', 'Email\na@b.test', 'Company,Email\nA,invalid', 'Company,Company name\nA,B']) assert.throws(() => previewCrmImport(csv));
});
test('notes cannot mutate pipeline state and follow-up values must be dates', () => {
  assert.throws(() => crmInput({kind:'NOTE',requestId:randomUUID(),note:'x',stage:'WON'}));
  assert.throws(() => crmInput({kind:'UPDATE',requestId:randomUUID(),note:''}));
  assert.throws(() => crmInput({kind:'UPDATE',requestId:randomUUID(),note:'',followUpAt:123}));
});
const enabled = process.env.CRM_TEST_DB === '1';
let server: Server, base: string, org: any, other: any, owner: any, caller: any, caller2: any, group: any, denied: any, foreign: any, lead: any, ownerToken: string, callerToken: string, secondToken: string;
function token(u: any) { return signAccessToken({userId:u.id,email:u.email,organizationId:u.organizationId,role:u.role,tv:0}); }
async function request(path: string, auth=callerToken, body?: any, method=body?'POST':'GET') {
  const r = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const text=await r.text(); let data:any; try { data=JSON.parse(text); } catch { data=text; } return {status:r.status,data:data?.data ?? data};
}
before(async () => {
  if (!enabled) return;
  const db=new URL(process.env.DATABASE_URL!); if(db.hostname!=='127.0.0.1'||db.port!=='55439') throw Error('CRM tests require isolated localhost:55439 database');
  const suffix=randomUUID();
  org=await prisma.organization.create({data:{name:'CRM test',slug:'crm-'+suffix,paused:true}});
  other=await prisma.organization.create({data:{name:'Other',slug:'other-'+suffix,paused:true}});
  const make=(role:any,email:string)=>prisma.user.create({data:{organizationId:org.id,email:email+suffix+'@example.test',firstName:role,lastName:'Tester',passwordHash:'unused',role,notifyByEmail:false}});
  owner=await make('OWNER','owner'); caller=await make('CALLER','caller'); caller2=await make('CALLER','second');
  ownerToken=token(owner);callerToken=token(caller);secondToken=token(caller2);
  group=await prisma.leadGroup.create({data:{organizationId:org.id,name:'Tampa'}});
  denied=await prisma.leadGroup.create({data:{organizationId:org.id,name:'Not assigned'}});
  foreign=await prisma.leadGroup.create({data:{organizationId:other.id,name:'Other tenant'}});
  lead=await prisma.lead.create({data:{organizationId:org.id,groupId:group.id,companyName:'Example Motors',phone:'555-0100',aiSummary:'PRIVATE ENGINE NOTE',contacts:{create:{organizationId:org.id,firstName:'Pat',email:'pat@example.test'}}}});
  await prisma.crmGrant.createMany({data:[{userId:caller.id,groupId:group.id},{userId:caller2.id,groupId:group.id}]});
  server=app.listen(0,'127.0.0.1'); await new Promise<void>(resolve=>server.once('listening',resolve)); base='http://127.0.0.1:'+(server.address() as any).port;
});
after(async()=>{if(!enabled)return;await prisma.organization.deleteMany({where:{id:{in:[org.id,other.id]}}});await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
const it=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!enabled},fn);
it('caller is denied every non-CRM API family, even with a forged role snapshot',async()=>{
  const stale=signAccessToken({userId:caller.id,email:caller.email,organizationId:org.id,role:'OWNER',tv:0});
  for(const p of ['engine','leads','contacts','lead-groups','settings','organizations','admin','campaigns','scheduled','voice','sending','notifications','conversations','dashboard','agent','models','playbooks','booking-links','gmail','social-accounts','test','sandbox','experiments','calendar']) assert.equal((await request('/api/'+p,stale)).status,403,p);
});
it('group grants isolate list, detail, writes, CSV and membership administration',async()=>{
  assert.equal((await request('/api/crm/groups')).data.length,1);
  assert.equal((await request(`/api/crm/groups/${denied.id}/leads`)).status,403);
  assert.equal((await request(`/api/crm/groups/${foreign.id}/leads`)).status,404);
  assert.equal((await request(`/api/crm/groups/${denied.id}/export`)).status,403);
  assert.equal((await request(`/api/crm/groups/${group.id}/members`)).status,403);
  assert.equal((await request(`/api/crm/groups/${denied.id}/leads/${lead.id}/events`,callerToken,{kind:'NOTE',note:'x',requestId:randomUUID()})).status,403);
  const detail=(await request(`/api/crm/groups/${group.id}/leads/${lead.id}`)).data;
  assert.equal(detail.aiSummary,undefined);assert.equal(detail.contacts[0].email,'pat@example.test');
});
it('calls have immutable attribution, retries do not double-count, notes do not count',async()=>{
  const path=`/api/crm/groups/${group.id}/leads/${lead.id}/events`;
  const payload={kind:'CALL',outcome:'ANSWERED',note:'Spoke to Pat',requestId:randomUUID()};
  assert.equal((await request(path,callerToken,payload)).status,201);
  assert.equal((await request(path,callerToken,payload)).status,201);
  await request(path,secondToken,{kind:'CALL',outcome:'INTERESTED',note:'Demo requested',requestId:randomUUID()});
  await request(path,callerToken,{kind:'NOTE',note:'Bring brochure',requestId:randomUUID()});
  const detail=(await request(`/api/crm/groups/${group.id}/leads/${lead.id}`)).data;
  assert.equal(detail.crmRecord.callCount,2);assert.equal(detail.crmRecord.stage,'INTERESTED');assert.equal(detail.crmEvents.length,3);
  assert.ok(detail.crmEvents.some((e:any)=>e.userId===caller2.id));
  const stats=(await request(`/api/crm/groups/${group.id}/stats`)).data;assert.equal(stats.length,2);
});
it('enrichment filters apply before pagination, combine with CRM filters, and preserve group access',async()=>{
  const prefix='Enrichment test '+randomUUID();
  const tiers=['NONE','MINIMAL','PARTIAL','GOOD','RICH'] as const;
  try {
    await prisma.lead.createMany({data:[
      ...Array.from({length:55},(_,i)=>({organizationId:org.id,groupId:group.id,companyName:prefix+' Rich '+i,enrichmentTier:'RICH' as const})),
      ...tiers.filter(t=>t!=='RICH').map(enrichmentTier=>({organizationId:org.id,groupId:group.id,companyName:prefix+' '+enrichmentTier,enrichmentTier})),
      {organizationId:org.id,groupId:denied.id,companyName:prefix+' Denied',enrichmentTier:'RICH'},
      {organizationId:other.id,groupId:foreign.id,companyName:prefix+' Foreign',enrichmentTier:'RICH'},
    ]});
    const path=`/api/crm/groups/${group.id}/leads?search=${encodeURIComponent(prefix)}`;
    for(const tier of tiers) {
      const result=await request(path+'&tier='+tier);
      assert.equal(result.status,200);assert.equal(result.data.total,tier==='RICH'?55:1);
      assert.ok(result.data.leads.every((l:any)=>l.enrichmentTier===tier));
    }
    const first=(await request(path+'&tier=RICH')).data;
    const second=(await request(path+'&tier=RICH&page=2')).data;
    assert.equal(first.leads.length,50);assert.equal(second.leads.length,5);assert.equal(second.total,55);
    assert.equal(new Set([...first.leads,...second.leads].map(l=>l.id)).size,55);
    await prisma.crmRecord.create({data:{leadId:first.leads[0].id,stage:'FOLLOW_UP',followUpAt:new Date(0)}});
    assert.equal((await request(path+'&tier=RICH&stage=NEW')).data.total,54);
    const due=(await request(path+'&tier=RICH&stage=FOLLOW_UP&due=true')).data;
    assert.equal(due.total,1);assert.equal(due.leads[0].id,first.leads[0].id);
    assert.equal((await request(path+'&tier=')).data.total,59);
    assert.equal((await request(path+'&tier=INVALID')).status,400);
    assert.equal((await request(`/api/crm/groups/${denied.id}/leads?tier=RICH`)).status,403);
    assert.equal((await request(`/api/crm/groups/${foreign.id}/leads?tier=RICH`)).status,404);
  } finally {
    await prisma.lead.deleteMany({where:{organizationId:{in:[org.id,other.id]},companyName:{startsWith:prefix}}});
  }
});
it('concurrent retries save one call and concurrent callers keep both calls',async()=>{
  const path=`/api/crm/groups/${group.id}/leads/${lead.id}/events`;
  const payload={kind:'CALL',outcome:'NO_ANSWER',note:'',requestId:randomUUID()};
  const results=await Promise.all([request(path,callerToken,payload),request(path,callerToken,payload)]);
  assert.deepEqual(results.map(r=>r.status),[201,201]);
  await Promise.all([request(path,callerToken,{...payload,requestId:randomUUID()}),request(path,secondToken,{...payload,requestId:randomUUID()})]);
  const record=await prisma.crmRecord.findUniqueOrThrow({where:{leadId:lead.id}});
  assert.equal(record.callCount,5);assert.equal(record.stage,'INTERESTED');
});
it('do-not-contact propagates to source lead and blocks further calls',async()=>{
  const path=`/api/crm/groups/${group.id}/leads/${lead.id}/events`;
  assert.equal((await request(path,callerToken,{kind:'CALL',outcome:'DO_NOT_CONTACT',note:'Stop requested',requestId:randomUUID()})).status,201);
  assert.equal((await prisma.lead.findUniqueOrThrow({where:{id:lead.id}})).doNotContact,true);
  assert.equal((await request(path,callerToken,{kind:'CALL',outcome:'ANSWERED',note:'',requestId:randomUUID()})).status,409);
});
it('CSV exports full group with all contacts and requires an export grant',async()=>{
  assert.equal((await request(`/api/crm/groups/${group.id}/export`)).status,403);
  const r=await request(`/api/crm/groups/${group.id}/export`,ownerToken);assert.equal(r.status,200);assert.match(r.data,/pat@example.test/);assert.doesNotMatch(r.data,/PRIVATE ENGINE NOTE/);
  await prisma.crmGrant.update({where:{userId_groupId:{userId:caller.id,groupId:group.id}},data:{canExport:true}});
  assert.equal((await request(`/api/crm/groups/${group.id}/export`)).status,200);
});
it('invites are one use and create caller-only accounts; existing accounts cannot be hijacked',async()=>{
  const email='invited-'+randomUUID()+'@example.test';
  const invitation=await request(`/api/crm/groups/${group.id}/invites`,ownerToken,{email});assert.equal(invitation.status,201);
  const token=new URL(invitation.data.inviteUrl).hash.slice(1);
  const payload={token,firstName:'Invited',lastName:'Caller',password:'LocalTestPassword123!'};
  assert.equal((await request('/api/crm/accept-invite','',payload)).status,201);
  assert.equal((await request('/api/crm/accept-invite','',payload)).status,410);
  assert.equal((await prisma.user.findUniqueOrThrow({where:{email}})).role,'CALLER');
  assert.equal((await request(`/api/crm/groups/${group.id}/invites`,ownerToken,{email:owner.email})).status,409);
});
it('expired and revoked invitations cannot create accounts',async()=>{
  for(const mode of ['expired','revoked']) {
    const email=mode+randomUUID()+'@example.test';
    const result=await request(`/api/crm/groups/${group.id}/invites`,ownerToken,{email});
    const token=new URL(result.data.inviteUrl).hash.slice(1);
    const invite=await prisma.crmInvite.findFirstOrThrow({where:{email}});
    if(mode==='expired') await prisma.crmInvite.update({where:{id:invite.id},data:{expiresAt:new Date(0)}});
    else await request(`/api/crm/groups/${group.id}/invites/${invite.id}`,ownerToken,undefined,'DELETE');
    assert.equal((await request('/api/crm/accept-invite','',{token,firstName:'Test',password:'LocalPassword123!'})).status,410);
  }
});
it('revocation takes effect with an already-issued token',async()=>{
  const grant=await prisma.crmGrant.findUniqueOrThrow({where:{userId_groupId:{userId:caller.id,groupId:group.id}}});
  assert.equal((await request(`/api/crm/groups/${group.id}/members/${grant.id}`,ownerToken,undefined,'DELETE')).status,200);
  assert.equal((await request(`/api/crm/groups/${group.id}/leads`)).status,403);
  assert.equal((await request('/api/crm/groups')).data.length,0);
});
it('caller cannot subscribe to internal workspace email notifications',async()=>{
  assert.equal((await request('/api/auth/me/notifications',secondToken,{notifyByEmail:true},'PATCH')).status,403);
  assert.equal((await prisma.user.findUniqueOrThrow({where:{id:caller2.id}})).notifyByEmail,false);
});
it('imports are manager-only and reject foreign groups before processing files',async()=>{
  const csv='Company,Contact,Email\nImported Company,Alex,alex@example.test\n';
  for (const action of ['import','import/preview']) {
    assert.equal((await request(`/api/crm/groups/${group.id}/${action}`,secondToken,{csv})).status,403);
    assert.equal((await request(`/api/crm/groups/${foreign.id}/${action}`,ownerToken,{csv})).status,404);
  }
});
it('repeat and concurrent imports retain all contacts without moving leads or duplicating records',async()=>{
  const csv='Company,Contact,Company phone,Contact phone,Email,City\nImported Company,Alex,+15555550100,+15555550101,alex@example.test,Tampa\nImported Company,Jordan,+15555550100,+15555550102,,Tampa\n';
  const path=`/api/crm/groups/${group.id}/import`;
  const preview=await request(path+'/preview',ownerToken,{csv}); assert.equal(preview.status,200); assert.equal(preview.data.total,2);
  assert.equal(await prisma.lead.count({where:{groupId:group.id,companyName:'Imported Company'}}),0);
  const responses=await Promise.all([request(path,ownerToken,{csv}),request(path,ownerToken,{csv})]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);
  assert.equal(responses.reduce((n,r)=>n+r.data.created,0),1);
  const imported=await prisma.lead.findFirstOrThrow({where:{groupId:group.id,companyName:'Imported Company'},include:{contacts:true}});
  assert.equal(imported.contacts.length,2); assert.equal(imported.phone,'+15555550100');
  assert.equal(imported.contacts.find(c=>c.firstName==='Alex')?.phone,'+15555550101');
  assert.equal(imported.contactCount,2);
  const otherGroupCsv=`Company,Lead ID\nMoved,${imported.id}\n`;
  assert.equal((await request(`/api/crm/groups/${denied.id}/import`,ownerToken,{csv:otherGroupCsv})).status,400);
  assert.equal((await prisma.lead.findUniqueOrThrow({where:{id:imported.id}})).groupId,group.id);
});
it('CSV round trips preserve calls, verification, opt-outs, and contacts without emails',async()=>{
  const original=await prisma.lead.findUniqueOrThrow({where:{id:lead.id},include:{crmRecord:true,contacts:true}});
  const verifiedAt=new Date();
  await prisma.contact.update({where:{id:original.contacts[0].id},data:{emailVerifiedAt:verifiedAt,emailVerifiedAddress:'pat@example.test',optedOut:true}});
  const csv=(await request(`/api/crm/groups/${group.id}/export`,ownerToken)).data;
  const result=await request(`/api/crm/groups/${group.id}/import`,ownerToken,{csv}); assert.equal(result.status,200); assert.equal(result.data.created,0); assert.equal(result.data.contactsCreated,0);
  const after=await prisma.lead.findUniqueOrThrow({where:{id:lead.id},include:{crmRecord:true,contacts:true}});
  assert.equal(after.doNotContact,true); assert.equal(after.crmRecord?.callCount,original.crmRecord?.callCount);
  assert.equal(after.contacts[0].emailVerifiedAt?.getTime(),verifiedAt.getTime()); assert.equal(after.contacts[0].optedOut,true);
  const restore=`Company,Lead ID,Contact ID,Do not contact,Contact opted out\nExample Motors,${lead.id},${original.contacts[0].id},false,false\n`;
  assert.equal((await request(`/api/crm/groups/${group.id}/import`,ownerToken,{csv:restore})).status,200);
  assert.equal((await prisma.lead.findUniqueOrThrow({where:{id:lead.id}})).doNotContact,true);
  assert.equal((await prisma.contact.findUniqueOrThrow({where:{id:original.contacts[0].id}})).optedOut,true);
});
it('invalid contact IDs roll back the entire import',async()=>{
  const csv=`Company,Lead ID,Contact ID\nMust roll back,,\nExample Motors,${lead.id},not-a-contact\n`;
  assert.equal((await request(`/api/crm/groups/${group.id}/import`,ownerToken,{csv})).status,400);
  assert.equal(await prisma.lead.count({where:{groupId:group.id,companyName:'Must roll back'}}),0);
});
