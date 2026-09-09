import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '../../src/config/database';

/** Disposable local fixture. No provider keys, real recipients, or scheduler. */
export async function groupFixture() {
  const tag = randomUUID();
  const org = await prisma.organization.create({ data: { name: 'Local workflow preview', slug: 'workflow-' + tag, paused: true } });
  const otherOrg = await prisma.organization.create({ data: { name: 'Other tenant fixture', slug: 'other-' + tag, paused: true } });
  const user = await prisma.user.create({ data: { organizationId: org.id, email: `preview-${tag}@example.test`, passwordHash: await bcrypt.hash('LocalPreview123!', 10), firstName: 'Local', lastName: 'Preview', role: 'OWNER', notifyByEmail: false } });
  const a = await prisma.leadGroup.create({ data: { organizationId: org.id, name: 'Dealerships · local preview', goal: 'Find qualified dealerships, test our offer, and handle interested replies.' } });
  const b = await prisma.leadGroup.create({ data: { organizationId: org.id, name: 'Freight · local preview', goal: 'Qualify regional freight companies.' } });
  const foreign = await prisma.leadGroup.create({ data: { organizationId: otherOrg.id, name: 'Other tenant', goal: 'Must never appear in the first tenant.' } });
  const leadA = await prisma.lead.create({ data: { organizationId: org.id, groupId: a.id, companyName: 'Sample Motors', status: 'ENGAGED', enrichmentScore: 70, enrichmentTier: 'GOOD', emailCount: 1, city: 'Baltimore', state: 'MD' } });
  const leadB = await prisma.lead.create({ data: { organizationId: org.id, groupId: b.id, companyName: 'Sample Freight', status: 'NEW' } });
  const orphan = await prisma.lead.create({ data: { organizationId: org.id, companyName: 'Unassigned sample' } });
  const pb = await prisma.playbook.create({ data: { organizationId: org.id, name: 'Dealership offer', scope: 'GROUP', groupId: a.id, instructions: 'Offer a short discovery call. Never invent results.' } });
  const otherPb = await prisma.playbook.create({ data: { organizationId: org.id, name: 'Freight offer', scope: 'GROUP', groupId: b.id, instructions: 'Ask about freight needs.' } });
  await prisma.playbook.create({ data: { organizationId: org.id, name: 'Shared reply rules', scope: 'GLOBAL', instructions: 'Honor opt-outs.' } });
  const campaign = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Discovery outreach · paused fixture', offer: 'Short discovery call', channels: ['EMAIL'], status: 'PAUSED', autoEnrollGroupId: a.id } });
  const sequence = await prisma.campaign.create({ data: { organizationId: org.id, name: 'Approved sequence · draft fixture', channels: ['EMAIL'], autoEnrollGroupId: a.id, sequenceEnabled: true, sequenceSteps: [{ id: 'step-one', subject: 'A short introduction', body: 'Would a short conversation be useful?', delayDays: 3, approved: true }] } });
  await prisma.campaignLead.createMany({ data: [{ campaignId: campaign.id, leadId: leadA.id }, { campaignId: campaign.id, leadId: leadB.id }, { campaignId: sequence.id, leadId: leadA.id }] });
  const experiment = await prisma.experiment.create({ data: { organizationId: org.id, groupId: a.id, campaignId: campaign.id, name: 'Question vs. benefit', channel: 'EMAIL', variants: { create: [{ label: 'Question', content: 'Ask a useful question.' }, { label: 'Benefit', content: 'Explain the benefit.' }] } }, include: { variants: true } });
  await prisma.experiment.create({ data: { organizationId: org.id, groupId: b.id, name: 'Freight-only test', channel: 'EMAIL' } });
  const run = await prisma.agentRun.create({ data: { organizationId: org.id, userId: user.id, groupId: a.id, role: 'SDR', trigger: 'USER_CHAT', objective: 'Preview the question variant for Sample Motors.', status: 'COMPLETED', summary: 'Fixture: the question approach was selected for a concise introduction.', finishedAt: new Date() } });
  const conversation = await prisma.conversation.create({ data: { organizationId: org.id, leadId: leadA.id, channel: 'EMAIL', subject: 'A useful question', lastMessageAt: new Date(), messages: { create: [{ direction: 'OUTBOUND', body: 'How are you following up with missed inquiries?', status: 'sent', campaignId: campaign.id, experimentVariantId: experiment.variants[0].id, provenance: { source: 'engine', groupId: a.id, groupName: a.name, playbookId: pb.id, playbookName: pb.name, routingPlaybookName: pb.name, runId: run.id, reason: 'Fixture: Engine selected the question variant.' } }, { direction: 'INBOUND', body: 'Can you share more details?', status: 'received' }] } } });
  await prisma.conversation.create({ data: { organizationId: org.id, leadId: leadB.id, channel: 'EMAIL', messages: { create: { direction: 'OUTBOUND', body: 'Freight fixture only', status: 'draft' } } } });
  const legacy = await prisma.conversation.create({ data: { organizationId: org.id, leadId: orphan.id, channel: 'EMAIL', messages: { create: { direction: 'OUTBOUND', body: 'Legacy fixture, attribution absent', status: 'sent' } } } });
  const chat = await prisma.engineChat.create({ data: { organizationId: org.id, userId: user.id, groupId: a.id, playbookId: pb.id, title: 'Prepare dealership outreach', messages: { create: { role: 'assistant', content: 'The offer is ready to rehearse. Check the sender details before activation.' } } } });
  return { org, otherOrg, user, a, b, foreign, leadA, leadB, orphan, pb, otherPb, campaign, sequence, experiment, conversation, legacy, chat };
}
