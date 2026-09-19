import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import router from '../src/routes/campaigns.routes';
import { prisma } from '../src/config/database';

const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });
function stub(target: any, name: string, replacement: (...args: any[]) => any) {
  const original = target[name];
  let calls = 0;
  target[name] = (...args: any[]) => { calls++; return replacement(...args); };
  restores.push(() => { target[name] = original; });
  return { callCount: () => calls };
}

// Real handlers with an isolated data layer: these tests never access a database.
function request(path: string, query: Record<string, string> = {}): Promise<any> {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route.methods.get);
  assert.ok(layer);
  return new Promise((resolve, reject) => layer.route.stack[0].handle(
    { params: { id: 'campaign' }, query, user: { organizationId: 'org' } },
    { json: resolve }, reject
  ));
}

test('enrolled leads paginate past 200 with group-scoped totals and stable ordering', async () => {
  stub(prisma.leadGroup, 'findFirst', async () => ({ id: 'group' }));
  stub(prisma.campaignLead, 'count', async (args: any) => {
    assert.deepEqual(args.where, { campaignId: 'campaign', campaign: { organizationId: 'org' }, lead: { groupId: 'group' } });
    return 251;
  });
  stub(prisma.campaign, 'findFirst', async (args: any) => {
    assert.equal(args.where.organizationId, 'org');
    assert.equal(args.include.campaignLeads.skip, 250);
    assert.equal(args.include.campaignLeads.take, 25);
    assert.deepEqual(args.include.campaignLeads.where, { lead: { groupId: 'group' } });
    assert.deepEqual(args.include.campaignLeads.orderBy, [{ createdAt: 'desc' }, { id: 'asc' }]);
    return { _count: { campaignLeads: 300 }, campaignLeads: [{ id: 'last' }] };
  });
  const result = await request('/:id', { groupId: 'group', leadPage: '999', leadPageSize: '25' });
  assert.equal(result.data.leadTotal, 251);
  assert.equal(result.data.leadPage, 11);
  assert.equal(result.data.campaignLeads[0].id, 'last');
});

test('empty enrollments and invalid page values resolve to page one', async () => {
  stub(prisma.campaignLead, 'count', async () => 0);
  stub(prisma.campaign, 'findFirst', async (args: any) => {
    assert.equal(args.include.campaignLeads.skip, 0);
    assert.equal(args.include.campaignLeads.take, 200);
    return { _count: { campaignLeads: 0 }, campaignLeads: [] };
  });
  const result = await request('/:id', { leadPage: '-3', leadPageSize: 'invalid' });
  assert.equal(result.data.leadPage, 1);
  assert.equal(result.data.leadTotal, 0);
});

test('upcoming pages clamp after removal and count the same eligible records', async () => {
  stub(prisma.campaign, 'findFirst', async (args: any) => {
    assert.equal(args.where.organizationId, 'org');
    return { id: 'campaign' };
  });
  let countedWhere: any;
  stub(prisma.campaignLead, 'count', async (args: any) => {
    if (args.where.status === 'COMPLETED') return 4;
    countedWhere = args.where;
    return 20;
  });
  stub(prisma.campaignLead, 'findMany', async (args: any) => {
    assert.deepEqual(args.where, countedWhere);
    assert.equal(args.skip, 10);
    assert.equal(args.take, 10);
    assert.deepEqual(args.orderBy.at(-1), { id: 'asc' });
    return [];
  });
  stub(prisma.campaignCycle, 'findMany', async () => []);
  const result = await request('/:id/schedule', { page: '3', pageSize: '10' });
  assert.equal(result.data.page, 2);
  assert.equal(result.data.upcomingTotal, 20);
  assert.equal(result.data.dormantCount, 4);
});

test('schedule rejects inaccessible campaigns before reading enrollments', async () => {
  stub(prisma.campaign, 'findFirst', async () => null);
  const count = stub(prisma.campaignLead, 'count', async () => { throw new Error('Unexpected count'); });
  await assert.rejects(request('/:id/schedule'), /Campaign not found/);
  assert.equal(count.callCount(), 0);
});
