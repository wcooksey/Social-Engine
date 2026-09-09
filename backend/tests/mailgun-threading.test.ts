import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emailThreadHeaders, replyMessageIds } from '../src/services/email-thread-headers';
import { prisma } from '../src/config/database';
import { handleInbound } from '../src/services/inbound.service';
import { executeTool } from '../src/engine/tools';
import { sendEmail } from '../src/services/channels.service';

test('Mailgun serialized and direct headers preserve thread chain', () => {
 const h=emailThreadHeaders({'message-headers':JSON.stringify([['Message-ID','<reply@example.test>'],['In-Reply-To','<parent@example.test>'],['References','<first@example.test> <parent@example.test>']])});
 assert.equal(h.externalId,'<reply@example.test>');
 assert.deepEqual(replyMessageIds(h.inReplyTo,h.references),['parent@example.test','first@example.test']);
 assert.equal(emailThreadHeaders({'message-headers':'invalid','In-Reply-To':'<direct@example.test>'}).inReplyTo,'<direct@example.test>');
});
test('Mailgun transmits reply headers without a real provider call',async()=>{
 const original=globalThis.fetch; let form:FormData|undefined;
 globalThis.fetch=async(_url,init)=>{form=init?.body as FormData;return new Response(JSON.stringify({id:'<sent@example.test>'}),{status:200});};
 try {
  assert.equal((await sendEmail({to:'owner@example.test',subject:'Re: Test',body:'Ack',inReplyTo:'<reply@example.test>',references:['<parent@example.test>','<reply@example.test>']},{apiKey:'fixture',domain:'example.test',fromEmail:'sender@example.test'})).sent,true);
  assert.equal(form?.get('h:In-Reply-To'),'<reply@example.test>');
  assert.equal(form?.get('h:References'),'<parent@example.test> <reply@example.test>');
 }finally{globalThis.fetch=original;}
});
const enabled=process.env.GROUP_WORKSPACE_TEST_DB==='1';
const it=(name:string,fn:()=>Promise<void>)=>test(name,{skip:!enabled},fn);
let org:string,other:string,leadA:string,leadB:string,contactB:string,threadA:string,threadB:string;
const address=`owner-${randomUUID()}@example.test`;
before(async()=>{
 if(!enabled)return;
 assert.ok(['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL!).hostname));
 org=(await prisma.organization.create({data:{name:'Thread fixture',slug:randomUUID(),paused:true}})).id;
 other=(await prisma.organization.create({data:{name:'Other fixture',slug:randomUUID(),paused:true}})).id;
 for(const name of ['Older lead','New test']){
  const lead=await prisma.lead.create({data:{organizationId:org,companyName:name}});
  const contact=await prisma.contact.create({data:{organizationId:org,leadId:lead.id,firstName:'Owner',email:address}});
  const t=await prisma.conversation.create({data:{organizationId:org,leadId:lead.id,contactId:contact.id,channel:'EMAIL',messages:{create:{direction:'OUTBOUND',body:'Test',status:'sent',externalId:`${lead.id}@example.test`,headerMessageId:`<${lead.id}@example.test>`}}}});
  if(!leadA){leadA=lead.id;threadA=t.id;}else{leadB=lead.id;contactB=contact.id;threadB=t.id;}
 }
});
after(async()=>{if(enabled){await prisma.organization.deleteMany({where:{id:{in:[org,other].filter(Boolean)}}});await prisma.$disconnect();}});
it('duplicate email routes to referenced lead and exact AI conversation, retries are idempotent',async()=>{
 const input={organizationId:org,channel:'EMAIL' as const,fromEmail:address,body:'THREAD TEST',externalId:'<reply@example.test>',inReplyTo:`<${leadB}@example.test>`};
 assert.equal((await handleInbound(input)).conversationId,threadB);
 assert.equal(await prisma.message.count({where:{conversationId:threadA,direction:'INBOUND'}}),0);
 assert.equal((await prisma.lead.findUniqueOrThrow({where:{id:leadA}})).coldOutreachHeldAt,null);
 const job=await prisma.agentJob.findFirstOrThrow({where:{organizationId:org,leadId:leadB}});
 assert.ok(job.objective.includes(`conversationId ${threadB}`));assert.ok(job.objective.includes(`contactId ${contactB}`));
 await handleInbound(input);
 assert.equal(await prisma.message.count({where:{conversationId:threadB,direction:'INBOUND'}}),1);
 assert.equal(await prisma.agentJob.count({where:{organizationId:org,leadId:leadB}}),1);
});
it('References falls back from unknown immediate parent',async()=>{
 assert.equal((await handleInbound({organizationId:org,channel:'EMAIL',fromEmail:address,body:'Reference test',inReplyTo:'<missing@example.test>',references:`<${leadA}@example.test> <${leadB}@example.test>`})).conversationId,threadB);
});
it('ambiguous sender without original thread cannot select arbitrary lead',async()=>{
 const r=await handleInbound({organizationId:org,channel:'EMAIL',fromEmail:address,body:'Ambiguous'});
 assert.equal(r.matched,false);assert.match(r.reason!,/Ambiguous/);
});
it('foreign thread headers cannot cross organizations',async()=>{
 assert.equal((await handleInbound({organizationId:other,channel:'EMAIL',fromEmail:address,body:'Foreign',inReplyTo:`<${leadB}@example.test>`})).matched,false);
});
it('AI send rejects wrong lead conversation before provider access',async()=>{
 const r:any=await executeTool('send_email',{leadId:leadA,conversationId:threadB,subject:'Never send',body:'Never send'},{organizationId:org,runId:'fixture'});
 assert.equal(r.sent,false);assert.match(r.reason,/does not belong/);
});
it('AI draft stays on requested conversation when same contact has multiple threads',async()=>{
 await prisma.organization.update({where:{id:org},data:{postalAddress:'1 Fixture Way'}});
 await prisma.contact.update({where:{id:contactB},data:{emailVerifiedAt:new Date(),emailVerifiedAddress:address}});
 const second=await prisma.conversation.create({data:{organizationId:org,leadId:leadB,contactId:contactB,channel:'EMAIL',subject:'Exact thread'}});
 const run=await prisma.agentRun.create({data:{organizationId:org,role:'SDR',trigger:'USER_CHAT',objective:'Fixture draft',status:'RUNNING'}});
 const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('No provider calls allowed in draft test');};
 try{
  const result:any=await executeTool('send_email',{leadId:leadB,conversationId:second.id,subject:'Re: Exact thread',body:'Only this thread'},{organizationId:org,runId:run.id});
  assert.equal(result.conversationId,second.id);
  assert.equal(await prisma.message.count({where:{conversationId:second.id,body:{startsWith:'Only this thread'}}}),1);
 }finally{globalThis.fetch=original;}
});
